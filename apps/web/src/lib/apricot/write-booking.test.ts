/**
 * Apricot 寫入引擎 unit tests（MD §3 + §6 驗收 mock 版）— cw-apricotwrite-20260823-a1
 *
 * 全 mock：setTestCallFn 注入（唔打真 Apricot）+ fake prisma（monkey-patch）。
 * 覆蓋：
 *   - hkToUtc / addMinutesHhmm（HK 14:30 → UTC 06:30 — MD §6 驗收項）
 *   - buildBookingBody（舊客 clinicPatient:{id} / 新客 inline §0 payload；bookingType 唔傳）
 *   - createBooking：成功路 / 冪等重放同 apricotApptId / SLOT_TAKEN / checkClash 非陣列照行 /
 *     4xx → ERROR:create_rejected 可安全重試 / 5xx → ERROR:create → MANUAL_RECONCILE（唔重複落單）
 *   - updateBookingStatus 白名單（4 → 拒）/ removeBooking PUT + body [id]
 *   - rescheduleBooking（★ cwi-final S5-2）：checkClash→102→create 次序 + 冪等（同 key 重放 / clash 安全重試 / 新單 fail → RESCHEDULE_PARTIAL + MANUAL_RECONCILE 重放）
 *   - ★ cwi-final S5-1（T810）：create 成功但斷線 → 新 key 重試 → dedup 回舊單
 *   - ★ cwi-final S5-3①（T812）：remove 後同 key → IDEMPOTENCY_KEY_CONSUMED
 *   - ★ cwi-final S5-3②（T813）：IN_PROGRESS 並發 / stale / hash mismatch
 *   - syncDictionaries：upsert / 每日 skip / 0 行留舊
 *   - lock busy → APRICOT_BUSY
 *   - 🔴 PII：hostile response（塞 PII 欄）→ console 零內文
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../prisma'
import { setApricotLockClientFactoryForTest } from './lock'
import {
  hkToUtc,
  addMinutesHhmm,
  buildBookingBody,
  createBooking,
  updateBookingStatus,
  removeBooking,
  rescheduleBooking,
  syncDictionaries,
  setTestCallFn,
  ApricotWriteError,
  type CreateBookingInput,
  type WriteCallFn,
} from './write-booking'

type Any = any

// ── console 截取（PII 零洩漏斷言用）──────────────────────────────────
const logBuf: string[] = []
const realLog = console.log
const realWarn = console.warn
const realErr = console.error
function tee(): void {
  const push = (...a: any[]) => logBuf.push(a.map(String).join(' '))
  console.log = (...a: any[]) => { push(...a); realLog(...a) }
  console.warn = (...a: any[]) => { push(...a); realWarn(...a) }
  console.error = (...a: any[]) => { push(...a); realErr(...a) }
}
const ALL_LOG = () => logBuf.join('\n')
const PII_MARKERS = ['98765432', 'ABC12345(6)', 'medicalHistory', 'diagnosis', 'emergencyContact']

// ── 時間常量 ─────────────────────────────────────────────────────────
const DATE = '2026-09-01' // 未來日（測試 deterministic）
const OLD_DATE = '2026-08-28'

// ── fake Apricot call ────────────────────────────────────────────────
interface Call { path: string; method?: string; body?: any }
const calls: Call[] = []
let respond: (c: Call) => any = () => ({})
const mockCall: WriteCallFn = (path, init) => {
  const c: Call = {
    path,
    method: init?.method,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  }
  calls.push(c)
  return Promise.resolve(respond(c))
}

/** overview response 節點（同 getOverviewAppointments 形狀：開診時段 + 預約） */
function overviewRaw(dateStr: string, providerId: string, openFrom = 900, openTo = 1200): Any {
  const [y, m, d] = dateStr.split('-').map(Number)
  const utc = (hkMin: number) => new Date(Date.UTC(y, m - 1, d, 0, 0) + hkMin * 60_000 - 8 * 3600_000).toISOString()
  return {
    [dateStr]: {
      appointments: {
        [providerId]: {
          practitionerOpenSchs: { timeSlots: [{ startTime: openFrom, endTime: openTo }] },
          bookingDetail: [
            { bookingTime: utc(540), bookingEndTime: utc(570), bookingStatus: 0, isRemoved: false },
          ],
        },
      },
    },
  }
}

// ── fake prisma ──────────────────────────────────────────────────────
const writeLogs = new Map<string, Any>()
const dictRows = new Map<string, Any>()
const cacheRows: Any[] = []
const deleteManyWheres: Any[] = []
// ★ cwi-final S5-1：AppointmentIndex 可控 seed（dedup 路查同病人同時段）
const appointmentIndexRows: Any[] = []
let locked = true

const fakes = {
  $queryRaw: async (strings: Any) => {
    const sql = typeof strings === 'object' && strings.join ? strings.join('?') : String(strings)
    return [{ locked: /try_advisory_lock/.test(sql) ? locked : null }]
  },
  bookingWriteLog: {
    findUnique: async ({ where }: Any) => writeLogs.get(where.idempotencyKey) ?? null,
    upsert: async ({ where, update, create }: Any) => {
      const key = where.idempotencyKey
      const existing = writeLogs.get(key)
      if (existing) {
        Object.assign(existing, update)
      } else {
        const row = { id: `log-${key}`, createdAt: new Date(), ...create }
        writeLogs.set(key, row)
      }
      return writeLogs.get(key)
    },
    // ★ cwi-final S5-3①：remove 成功 → CREATE OK 行消耗（REMOVED）
    updateMany: async ({ where, data }: Any) => {
      let n = 0
      for (const row of writeLogs.values()) {
        const match =
          (where.action == null || row.action === where.action) &&
          (where.apricotApptId == null || row.apricotApptId === where.apricotApptId) &&
          (where.status == null || row.status === where.status)
        if (match) {
          Object.assign(row, data)
          n += 1
        }
      }
      return { count: n }
    },
  },
  // ★ S5-1 dedup 路：同病人同醫生同日同時段（status in [0,1]）→ 回舊單
  appointmentIndex: {
    findFirst: async ({ where }: Any) => {
      return (
        appointmentIndexRows.find((r) =>
          (where.providerApricotId == null || r.providerApricotId === where.providerApricotId) &&
          (where.date == null || r.date === where.date) &&
          (where.startTime == null || r.startTime === where.startTime) &&
          (where.patientApricotId == null || r.patientApricotId === where.patientApricotId) &&
          (where.bookingStatus?.in == null || where.bookingStatus.in.includes(r.bookingStatus)),
        ) ?? null
      )
    },
  },
  // 單日 sync 會查 provider 帳號映射（Stage 2 口徑：ApricotPractitioner 為唯一來源）
  apricotPractitioner: { findMany: async () => [{ apricotId: 'prov-1', providerId: 'p-1', kind: 'PROVIDER' }] },
  apricotDictionary: {
    findFirst: async ({ where }: Any) => {
      const rows = [...dictRows.values()].filter((r) => r.kind === where.kind)
      if (!rows.length) return null
      rows.sort((a, b) => (a.syncedAt > b.syncedAt ? 1 : -1))
      return { syncedAt: rows[rows.length - 1].syncedAt }
    },
    upsert: async ({ where, update, create }: Any) => {
      const existing = dictRows.get(where.apricotId)
      if (existing) Object.assign(existing, update)
      else dictRows.set(where.apricotId, create)
      return dictRows.get(where.apricotId)
    },
  },
  provider: { findMany: async () => [{ id: 'p-1', name: 'Dr. T' }] },
  patientIndex: { upsert: async () => ({}) },
  availabilityCache: {
    deleteMany: async (args: Any) => {
      deleteManyWheres.push(args.where)
      // 模擬真 DB：真刪
      for (let i = cacheRows.length - 1; i >= 0; i--) {
        const r = cacheRows[i]
        if (r.clinicId === args.where.clinicId && (!args.where.date || r.date === args.where.date)) {
          cacheRows.splice(i, 1)
        }
      }
      return { count: 0 }
    },
    createMany: async ({ data }: Any) => {
      cacheRows.push(...data)
      return { count: data.length }
    },
  },
  clinic: {
    findUnique: async () => ({ id: 'cl-1', apricotClinicId: 'apr-clinic-1' }),
  },
  $transaction: async (arg: Any) => (Array.isArray(arg) ? Promise.all(arg) : arg()),
}

let saved: [Any, string, Any][] = []
before(() => {
  tee()
  setTestCallFn(mockCall)
  // cwi-refresh-20260831：lock 改用 dedicated pg client — fake 經 test seam inject（dynamic 讀 locked flag）
  setApricotLockClientFactoryForTest(async () => ({
    query: async (sql: string) => ({ rows: [{ locked: /try_advisory_lock/.test(sql) ? locked : null }] }),
    release: () => {},
  }))
  for (const obj of [prisma]) {
    for (const k of Object.keys(fakes) as (keyof typeof fakes)[]) {
      saved.push([obj, k, (obj as Any)[k]])
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
  }
})
after(() => {
  setTestCallFn(null)
  setApricotLockClientFactoryForTest(null)
  console.log = realLog
  console.warn = realWarn
  console.error = realErr
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
})

beforeEach(() => {
  calls.length = 0
  writeLogs.clear()
  dictRows.clear()
  cacheRows.length = 0
  deleteManyWheres.length = 0
  appointmentIndexRows.length = 0
  logBuf.length = 0
  locked = true
  // 預設：checkClash 無衝突 / create 成功 / overview 有開診
  respond = (c) => {
    if (c.path.includes('checkClash')) return []
    if (c.path.endsWith('/booking-details') && c.method === 'POST') {
      return { id: 'apt-new-1', clinicPatient: { id: 'pat-1', code: 'P0001' } }
    }
    if (c.path.startsWith('/services/aepsmsappt/api/appointments/getOverviewAppointments')) {
      const qs = new URLSearchParams(c.path.split('?')[1] ?? '')
      return overviewRaw(qs.get('startDate') ?? DATE, 'prov-1')
    }
    if (c.path.includes('/visit-reasons')) return { list: [{ id: 'vr-1', code: '01', des: 'Follow-up', isRemoved: false }] }
    if (c.path.includes('/booking-types')) return [{ id: 'bt-1', code: 'T1', des: 'Consultation' }]
    return {}
  }
})

function baseInput(over: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    idempotencyKey: 'idemp-key-0001',
    clinicCuid: 'cl-1',
    apricotClinicId: 'apr-clinic-1',
    providerApricotId: 'prov-1',
    dateHk: DATE,
    startHk: '14:30',
    durationMin: 30,
    visitReasonId: 'vr-1',
    patient: { apricotId: 'pat-1' },
    requestedBy: 'contract-key',
    ...over,
  }
}

function createCallCount(): number {
  return calls.filter((c) => c.path.endsWith('/booking-details') && c.method === 'POST').length
}

// ── 純函數 ──────────────────────────────────────────────────────────

describe('hkToUtc / addMinutesHhmm（MD §6：14:30 → 06:30Z）', () => {
  it('HK 14:30 → UTC 06:30（落單對數用）', () => {
    assert.equal(hkToUtc('2026-09-01', '14:30'), '2026-09-01T06:30:00.000Z')
  })
  it('HK 00:00 → 前一日 UTC 16:00', () => {
    assert.equal(hkToUtc('2026-09-01', '00:00'), '2026-08-31T16:00:00.000Z')
  })
  it('偽日期 → throw', () => {
    assert.throws(() => hkToUtc('2026-02-30', '14:30'), ApricotWriteError)
  })
  it('addMinutesHhmm：23:00+59 → 23:59；23:00+60 → null（跨日拒）', () => {
    assert.equal(addMinutesHhmm('23:00', 59), '23:59')
    assert.equal(addMinutesHhmm('23:00', 60), null)
    assert.equal(addMinutesHhmm('09:30', 45), '10:15')
  })
})

describe('buildBookingBody（MD §0 payload）', () => {
  it('舊客：clinicPatient:{id}；bookingType 唔傳', () => {
    const body = buildBookingBody(baseInput(), 'S', 'E')
    assert.deepEqual(body.clinicPatient, { id: 'pat-1' })
    assert.equal('bookingType' in body, false)
    assert.equal(body.bookingTime, 'S')
    assert.equal(body.bookingEndTime, 'E')
  })
  it('新客：inline §0 證據原樣（firstName/phoneNum/referralType/privateSetting）', () => {
    const body = buildBookingBody(baseInput({ patient: { name: '王小明', phone: '91234567' } }), 'S', 'E')
    assert.deepEqual(body.clinicPatient, {
      firstName: '王小明',
      phoneNum: '91234567',
      referralType: 'OTHER',
      privateSetting: { clinics: [], isPrivate: false },
    })
  })
})

// ── createBooking ────────────────────────────────────────────────────

describe('createBooking', () => {
  it('成功路：checkClash [] → POST → WriteLog(OK) → 單日 sync（startDate=endDate=該日）', async () => {
    const r = await createBooking(baseInput())
    assert.equal(r.apricotApptId, 'apt-new-1')
    assert.equal(r.patientApricotId, 'pat-1')
    assert.equal(r.patientCode, 'P0001')
    assert.equal(r.dayRefreshed, true)
    assert.ok(r.syncedAt)
    assert.equal(r.replayed, false)
    assert.equal(createCallCount(), 1)

    // 單日 sync 真打咗 overview（startDate=endDate=DATE）
    const ov = calls.find((c) => c.path.includes('getOverviewAppointments'))
    assert.ok(ov, 'single-day overview call 缺失')
    const qs = new URLSearchParams(ov!.path.split('?')[1])
    assert.equal(qs.get('startDate'), DATE)
    assert.equal(qs.get('endDate'), DATE)
    assert.equal(qs.get('openSchClinicId'), 'apr-clinic-1')

    // WriteLog(OK)
    const log = writeLogs.get('idemp-key-0001')
    assert.equal(log.status, 'OK')
    assert.equal(log.action, 'CREATE')
    assert.equal(log.apricotApptId, 'apt-new-1')
    assert.equal(log.requestedBy, 'contract-key')
    // 🔴 零 PII：log row 只有白名單欄（★ S5-3②：CREATE 路多 requestHash）
    assert.deepEqual(Object.keys(log).sort(), ['action', 'apricotApptId', 'createdAt', 'id', 'idempotencyKey', 'requestHash', 'requestedBy', 'status'])
    assert.match(log.requestHash, /^[0-9a-f]{64}$/)
  })

  it('冪等重放：同 key → 同 apricotApptId、POST 只打一次（MD §6）', async () => {
    const r1 = await createBooking(baseInput())
    const r2 = await createBooking(baseInput())
    assert.equal(r2.apricotApptId, r1.apricotApptId)
    assert.equal(r2.replayed, true)
    assert.equal(r2.dayRefreshed, false) // 重放 = 無新寫入，唔重刷 cache
    assert.equal(createCallCount(), 1)
  })

  it('SLOT_TAKEN：checkClash length>0 → 409 mapped + WriteLog(SLOT_TAKEN) + 唔 POST', async () => {
    const prev = respond
    respond = (c) => (c.path.includes('checkClash') ? [{ conflict: true }] : prev(c))
    await assert.rejects(createBooking(baseInput()), (e: Any) => e instanceof ApricotWriteError && e.code === 'SLOT_TAKEN')
    assert.equal(createCallCount(), 0)
    assert.equal(writeLogs.get('idemp-key-0001')?.status, 'SLOT_TAKEN')
    // 重放 → 同樣 409（確定性）
    await assert.rejects(createBooking(baseInput()), (e: Any) => e instanceof ApricotWriteError && e.code === 'SLOT_TAKEN')
    assert.equal(createCallCount(), 0)
  })

  it('checkClash 非陣列 → warn metadata 照行（MD §0 規則）', async () => {
    const prev = respond
    respond = (c) => (c.path.includes('checkClash') ? { note: 'unexpected shape' } : prev(c))
    const r = await createBooking(baseInput())
    assert.equal(r.apricotApptId, 'apt-new-1')
    assert.match(ALL_LOG(), /checkClash 回應非陣列/)
    // warn 只記形狀，唔記值
    assert.ok(!ALL_LOG().includes('unexpected shape'))
  })

  it('create 4xx → ERROR:create_rejected（可安全重試）；重放成功', async () => {
    const prev = respond
    let tries = 0
    respond = (c) => {
      if (c.path.endsWith('/booking-details') && c.method === 'POST') {
        tries += 1
        if (tries === 1) throw new Error('APRICOT_HTTP_422: phone invalid')
      }
      return prev(c)
    }
    await assert.rejects(createBooking(baseInput()), (e: Any) => e instanceof ApricotWriteError && e.code === 'APRICOT_HTTP_422' && e.step === 'create')
    assert.equal(writeLogs.get('idemp-key-0001')?.status, 'ERROR:create_rejected')
    // consumer 用同 key 重放 → 安全重試 → 成功
    const r = await createBooking(baseInput())
    assert.equal(r.apricotApptId, 'apt-new-1')
    assert.equal(createCallCount(), 2)
    assert.equal(writeLogs.get('idemp-key-0001')?.status, 'OK')
  })

  it('create 5xx → ERROR:create（曖昧）；重放 → MANUAL_RECONCILE 唔重複落單（MD 鐵律）', async () => {
    const prev = respond
    let tries = 0
    respond = (c) => {
      if (c.path.endsWith('/booking-details') && c.method === 'POST') {
        tries += 1
        throw new Error('APRICOT_HTTP_500: server exploded')
      }
      return prev(c)
    }
    await assert.rejects(createBooking(baseInput()), (e: Any) => e instanceof ApricotWriteError && e.code === 'APRICOT_HTTP_500')
    assert.equal(writeLogs.get('idemp-key-0001')?.status, 'ERROR:create')
    // 重放 → 唔准再 POST（可能已落單）
    await assert.rejects(createBooking(baseInput()), (e: Any) => e instanceof ApricotWriteError && e.code === 'MANUAL_RECONCILE')
    assert.equal(tries, 1, '重放唔應該再打 create')
  })

  it('lock busy → APRICOT_BUSY（503 候選）', async () => {
    locked = false
    await assert.rejects(createBooking(baseInput()), (e: Any) => e instanceof ApricotWriteError && e.code === 'APRICOT_BUSY')
    assert.equal(calls.length, 0, 'lock 攞唔到就係零 Apricot call')
  })

  it('🔴 PII：hostile create response 塞 PII → console 零內文', async () => {
    const prev = respond
    respond = (c) => {
      if (c.path.endsWith('/booking-details') && c.method === 'POST') {
        return {
          id: 'apt-new-1',
          clinicPatient: {
            id: 'pat-1',
            code: 'P0001',
            phoneNum: '98765432',
            personalIdentifier: 'ABC12345(6)',
            medicalHistory: 'secrethistory',
            diagnosis: 'secret',
            emergencyContact: 'secret',
          },
        }
      }
      return prev(c)
    }
    const r = await createBooking(baseInput())
    assert.equal(r.apricotApptId, 'apt-new-1')
    for (const p of PII_MARKERS) {
      assert.ok(!ALL_LOG().includes(p), `log 含 PII：${p}`)
    }
  })
})

// ── cwi-final S5-1 / S5-3 新場景（T810 / T812 / T813）─────────────────

describe('cwi-final S5-1 先查後建 dedup（T810）', () => {
  it('第一次 create 成功但 response 前斷線 → 新 key 重試 → 回同一 apricotApptId + deduped:true，store 只 1 張', async () => {
    // mock「Apricot 側」store：記住實際落咗嘅單（server 收到 = 已落，即使 response 唔返到）
    const store: Any[] = []
    const prev = respond
    respond = (c) => {
      if (c.path.includes('checkClash')) return store.length > 0 ? [{ existing: true }] : []
      if (c.path.endsWith('/booking-details') && c.method === 'POST') {
        store.push({ id: 'apt-store-1' })
        if (store.length === 1) throw new Error('network: connection reset before response')
        return { id: 'apt-store-1', clinicPatient: { id: 'pat-1', code: 'P0001' } }
      }
      return prev(c)
    }

    // 第一次（key A）：server 已落單但 client 斷線 → 曖昧失敗（ERROR:create）
    await assert.rejects(createBooking(baseInput()), (e: Any) => e instanceof ApricotWriteError && e.code === 'network')
    assert.equal(createCallCount(), 1)
    assert.equal(writeLogs.get('idemp-key-0001')?.status, 'ERROR:create')

    // AppointmentIndex（由 day sync 更新）已有呢位病人同時段嘅單（status 0）
    appointmentIndexRows.push({
      apricotApptId: 'apt-store-1',
      providerApricotId: 'prov-1',
      date: DATE,
      startTime: '14:30',
      patientApricotId: 'pat-1',
      bookingStatus: 0,
    })

    // consumer 用新 key 重試（wa-inbox 重新對賬落單）→「先查後建」dedup 回舊單
    const r = await createBooking(baseInput({ idempotencyKey: 'idemp-key-0002' }))
    assert.equal(r.apricotApptId, 'apt-store-1')
    assert.equal(r.deduped, true)
    assert.equal(r.replayed, true)
    assert.equal(createCallCount(), 1, 'dedup 命中 = 唔會第二張 POST')
    assert.equal(store.length, 1, 'Apricot store 只有一張單')

    // 新 key 留底 OK（apricotApptId = 舊單）
    assert.equal(writeLogs.get('idemp-key-0002')?.status, 'OK')
    assert.equal(writeLogs.get('idemp-key-0002')?.apricotApptId, 'apt-store-1')

    // 唔係同一病人（index 冇佢）→ 照舊 SLOT_TAKEN（唔會錯對賬）
    await assert.rejects(
      createBooking(baseInput({ idempotencyKey: 'idemp-key-0003', patient: { apricotId: 'pat-other' } })),
      (e: Any) => e instanceof ApricotWriteError && e.code === 'SLOT_TAKEN',
    )
    assert.equal(store.length, 1)
  })
})

describe('cwi-final S5-3① removed key 消耗（T812）', () => {
  it('create → remove → 同 key create → 409 IDEMPOTENCY_KEY_CONSUMED（唔回舊單）', async () => {
    const r = await createBooking(baseInput())
    assert.equal(r.apricotApptId, 'apt-new-1')

    // remove 該單（remove 自己用合成 key）
    await removeBooking('apt-new-1', {
      requestedBy: 'contract-key',
      clinicCuid: 'cl-1',
      apricotClinicId: 'apr-clinic-1',
      dateHk: DATE,
    })
    // CREATE log 行 → REMOVED（key 消耗）
    assert.equal(writeLogs.get('idemp-key-0001')?.status, 'REMOVED')

    // 同 key create → 拒（舊單已唔存在 — 回舊單會令 consumer 誤以為單仲喺）
    await assert.rejects(createBooking(baseInput()), (e: Any) => e instanceof ApricotWriteError && e.code === 'IDEMPOTENCY_KEY_CONSUMED')
    assert.equal(createCallCount(), 1, '唔會再落單')

    // 新 key 可以照落（同時段已 remove → clash 解除）
    const r2 = await createBooking(baseInput({ idempotencyKey: 'idemp-key-0002' }))
    assert.equal(r2.apricotApptId, 'apt-new-1')
    assert.equal(r2.deduped, undefined)
  })
})

describe('cwi-final S5-3② requestHash 冪等（T813）', () => {
  it('同 key 同 payload 並發 → 一個 200、一個 409 IN_PROGRESS；之後重試 → 200 replayed:true', async () => {
    // (a) 第一寫入完成 → 200
    const r1 = await createBooking(baseInput())
    assert.equal(r1.replayed, false)

    // (b) 模擬另一 request 同 key 正喺寫入中（IN_PROGRESS 底）
    const row = writeLogs.get('idemp-key-0001')!
    const savedRow = { ...row }
    row.status = 'IN_PROGRESS'
    row.createdAt = new Date()
    await assert.rejects(createBooking(baseInput()), (e: Any) => e instanceof ApricotWriteError && e.code === 'IN_PROGRESS')
    assert.equal(createCallCount(), 1, '並發寫入中 = 唔會再打 Apricot')

    // (c) 在途寫入完成（還原 OK 底）→ 重試 = 冪等重放
    Object.assign(row, savedRow)
    const r2 = await createBooking(baseInput())
    assert.equal(r2.replayed, true)
    assert.equal(r2.apricotApptId, 'apt-new-1')
    assert.equal(createCallCount(), 1)
  })

  it('IN_PROGRESS 殘留 > 10 分鐘 → 502 MANUAL_RECONCILE；OK + 唔同 payload → 409 IDEMPOTENCY_MISMATCH', async () => {
    const r = await createBooking(baseInput())
    assert.equal(r.replayed, false)
    const row = writeLogs.get('idemp-key-0001')!
    const savedRow = { ...row }

    // stale IN_PROGRESS（> 10 min）→ 當殘留態
    row.status = 'IN_PROGRESS'
    row.createdAt = new Date(Date.now() - 11 * 60 * 1000)
    await assert.rejects(createBooking(baseInput()), (e: Any) => e instanceof ApricotWriteError && e.code === 'MANUAL_RECONCILE')

    // 還原 OK 底 + 唔同 payload（時段改咗）→ hash mismatch
    Object.assign(row, savedRow)
    await assert.rejects(
      createBooking(baseInput({ startHk: '15:00' })),
      (e: Any) => e instanceof ApricotWriteError && e.code === 'IDEMPOTENCY_MISMATCH',
    )
    assert.equal(createCallCount(), 1, 'mismatch 唔會再落單')

    // 同 payload 照樣重放得
    const r2 = await createBooking(baseInput())
    assert.equal(r2.replayed, true)
  })
})

// ── status / remove ──────────────────────────────────────────────────

describe('updateBookingStatus / removeBooking', () => {
  const opts = { requestedBy: 'contract-key', clinicCuid: 'cl-1', apricotClinicId: 'apr-clinic-1', dateHk: DATE }

  it('status=4 → STATUS_NOT_ALLOWED（白名單 102/-7，MD §6）', async () => {
    await assert.rejects(updateBookingStatus('apt-1', 4, opts), (e: Any) => e instanceof ApricotWriteError && e.code === 'STATUS_NOT_ALLOWED')
    assert.equal(calls.length, 0)
  })

  it('status=102 → PUT updateStatus + WriteLog(OK STATUS_102) + 單日 sync', async () => {
    const r = await updateBookingStatus('apt-1', 102, opts)
    assert.equal(r.bookingStatus, 102)
    assert.equal(r.dayRefreshed, true)
    const call = calls.find((c) => c.path.includes('updateStatus'))
    assert.ok(call, 'updateStatus call 缺失')
    assert.match(call!.path, /appointments\/apt-1\/updateStatus\?status=102$/)
    const logRow = [...writeLogs.values()].find((l) => l.action === 'STATUS_102')
    assert.equal(logRow?.status, 'OK')
    assert.equal(logRow?.apricotApptId, 'apt-1')
  })

  it('status=-7 → PUT updateStatus?status=-7', async () => {
    const r = await updateBookingStatus('apt-1', -7, opts)
    assert.equal(r.bookingStatus, -7)
    const call = calls.find((c) => c.path.includes('updateStatus'))
    assert.match(call!.path, /updateStatus\?status=-7$/)
    assert.ok([...writeLogs.values()].some((l) => l.action === 'STATUS_-7' && l.status === 'OK'))
  })

  it('remove → PUT（唔係 POST）+ body ["<id>"]（MD §0 實測，contract test 釘住）', async () => {
    const r = await removeBooking('apt-9', opts)
    assert.equal(r.removed, true)
    assert.equal(r.dayRefreshed, true)
    const call = calls.find((c) => c.path.includes('/remove'))
    assert.ok(call, 'remove call 缺失')
    assert.equal(call!.method, 'PUT')
    assert.match(call!.path, /booking-details\/remove\?recurApplyType=0$/)
    assert.deepEqual(call!.body, ['apt-9'])
    assert.ok([...writeLogs.values()].some((l) => l.action === 'REMOVE' && l.status === 'OK'))
  })

  it('remove 4xx → ERROR:remove + mapped error（唔重試）', async () => {
    respond = (c) => {
      if (c.path.includes('/remove')) throw new Error('APRICOT_HTTP_404: no such booking')
      return respond(c)
    }
    await assert.rejects(removeBooking('apt-9', opts), (e: Any) => e instanceof ApricotWriteError && e.code === 'APRICOT_HTTP_404' && e.step === 'remove')
    assert.ok([...writeLogs.values()].some((l) => l.status === 'ERROR:remove'))
  })
})

// ── reschedule（★ cwi-final S5-2 原子化 + 冪等）─────────────────────

describe('rescheduleBooking（S5-2）', () => {
  const base: Any = {
    oldApricotApptId: 'apt-old',
    idempotencyKey: 'resched-key-001',
    clinicCuid: 'cl-1',
    apricotClinicId: 'apr-clinic-1',
    providerApricotId: 'prov-1',
    oldDateHk: OLD_DATE,
    newDateHk: DATE,
    newStartHk: '15:00',
    newDurationMin: 30,
    patient: { apricotId: 'pat-1' },
    requestedBy: 'contract-key',
  }
  const count102 = () => calls.filter((c) => c.path.includes('updateStatus?status=102')).length

  it('T811 成功：次序 checkClash(新時段) → 102 → create；兩日各 refresh；同 key 重放 → replayed（只一張新單）', async () => {
    const r = await rescheduleBooking(base)
    assert.equal(r.oldApptId, 'apt-old')
    assert.equal(r.newApptId, 'apt-new-1')
    assert.equal(r.dayRefreshed, true)
    assert.equal(r.replayed, false)

    // 次序：checkClash 先（新時段）、後 102、最後 create
    const idxClash = calls.findIndex((c) => c.path.includes('checkClash'))
    const idx102 = calls.findIndex((c) => c.path.includes('updateStatus?status=102'))
    const idxCreate = calls.findIndex((c) => c.path.endsWith('/booking-details') && c.method === 'POST')
    assert.ok(idxClash >= 0 && idx102 > idxClash && idxCreate > idx102, `應該 checkClash→102→create（idx ${idxClash},${idx102},${idxCreate}）`)

    // 兩日各一次 overview（startDate=endDate 分別 = OLD_DATE / DATE）
    const ovs = calls.filter((c) => c.path.includes('getOverviewAppointments'))
    assert.equal(ovs.length, 2)
    const dates = ovs.map((c) => new URLSearchParams(c.path.split('?')[1]).get('startDate')).sort()
    assert.deepEqual(dates, [OLD_DATE, DATE])

    // WriteLog 底：|after102（102 已落）/ |create（新單 OK + requestHash）/ |ok（冪等錨）
    const k = base.idempotencyKey
    assert.equal(writeLogs.get(`${k}|after102`)?.status, 'OK:102_marked')
    assert.equal(writeLogs.get(`${k}|after102`)?.apricotApptId, 'apt-old')
    assert.equal(writeLogs.get(`${k}|create`)?.status, 'OK')
    assert.equal(writeLogs.get(`${k}|create`)?.apricotApptId, 'apt-new-1')
    assert.match(writeLogs.get(`${k}|create`)?.requestHash ?? '', /^[0-9a-f]{64}$/)
    assert.equal(writeLogs.get(`${k}|ok`)?.status, 'OK')
    assert.equal(writeLogs.get(`${k}|ok`)?.apricotApptId, 'apt-new-1')

    // 同 key 重試（W 側 timeout 重發）→ 重放：無新寫入
    const r2 = await rescheduleBooking(base)
    assert.equal(r2.replayed, true)
    assert.equal(r2.newApptId, 'apt-new-1')
    assert.equal(createCallCount(), 1, '重放 = 唔重複 create')
    assert.equal(count102(), 1, '重放 = 唔重複 102')
  })

  it('T811 新時段被佔：409 SLOT_TAKEN + 舊單未郁（零 102）；時段解咗先重試 → 只一張新單', async () => {
    let clash = true
    const prev = respond
    respond = (c) => (c.path.includes('checkClash') ? (clash ? [{ x: 1 }] : []) : prev(c))

    // 第一試：新時段被佔 → 409，舊單完全未郁
    await assert.rejects(rescheduleBooking(base), (e: Any) => e instanceof ApricotWriteError && e.code === 'SLOT_TAKEN')
    assert.equal(count102(), 0, 'clash = 唔打 102（舊單未郁）')
    assert.equal(createCallCount(), 0)
    assert.equal(writeLogs.get(base.idempotencyKey)?.status, 'SLOT_TAKEN')

    // 時段仍佔住 → 同 key 重試 → 確定性 409（安全重試）
    await assert.rejects(rescheduleBooking(base), (e: Any) => e instanceof ApricotWriteError && e.code === 'SLOT_TAKEN')
    assert.equal(count102(), 0)
    assert.equal(createCallCount(), 0)

    // 時段解咗 → 重試成功（唯一一張新單）
    clash = false
    const r = await rescheduleBooking(base)
    assert.equal(r.newApptId, 'apt-new-1')
    assert.equal(r.replayed, false)
    assert.equal(createCallCount(), 1)

    // 再重試 → 重放（總數仍係一張新單）
    const r2 = await rescheduleBooking(base)
    assert.equal(r2.replayed, true)
    assert.equal(createCallCount(), 1, '總數只一張新單')
  })

  it('新單 fail → RESCHEDULE_PARTIAL（extra.oldApptId）+ |after102=ERROR:create_after_102 + ALERT；重試 → 502 MANUAL_RECONCILE；唔自動 rollback', async () => {
    const prev = respond
    respond = (c) => {
      if (c.path.endsWith('/booking-details') && c.method === 'POST') throw new Error('APRICOT_HTTP_422: slot filled')
      return prev(c)
    }
    await assert.rejects(rescheduleBooking(base), (e: Any) =>
      e instanceof ApricotWriteError && e.code === 'RESCHEDULE_PARTIAL' && e.extra?.oldApptId === 'apt-old')

    // 殘留底：|after102 升級 ERROR:create_after_102（舊單確實已 102）
    const k = base.idempotencyKey
    assert.equal(writeLogs.get(`${k}|after102`)?.status, 'ERROR:create_after_102')
    assert.equal(writeLogs.get(`${k}|after102`)?.apricotApptId, 'apt-old')
    assert.ok(count102() >= 1, '舊單確實已標 102（殘留態成立）')
    // ALERT 行（workforce 現有 alert 機制）
    assert.match(ALL_LOG(), /reschedule 殘留態/)
    // 唔自動 rollback：無 -7 / remove call 打去舊單
    assert.equal(calls.filter((c) => c.path.includes('updateStatus?status=-7') || c.path.includes('/remove')).length, 0)

    // 重試同 key → |after102 存在 → MANUAL_RECONCILE（唔會重複打 102）
    const before = count102()
    await assert.rejects(rescheduleBooking(base), (e: Any) => e instanceof ApricotWriteError && e.code === 'MANUAL_RECONCILE')
    assert.equal(count102(), before, 'MANUAL_RECONCILE 重試唔會再打 102')
  })
})

// ── syncDictionaries ─────────────────────────────────────────────────

describe('syncDictionaries（nightly 掛現有 tick）', () => {
  it('force：兩條 GET → upsert（isRemoved 原樣入庫）', async () => {
    const prev = respond
    respond = (c) => {
      if (c.path.includes('/visit-reasons')) return { list: [{ id: 'vr-1', code: '01', des: 'Follow-up' }, { id: 'vr-2', code: '02', des: 'Removed one', isRemoved: true }] }
      if (c.path.includes('/booking-types')) return [{ id: 'bt-1', code: 'T1', des: 'Consultation' }]
      return prev(c)
    }
    const r = await syncDictionaries({ force: true, now: new Date('2026-08-23T05:00:00Z') })
    assert.deepEqual(r.synced, { VISIT_REASON: 2, BOOKING_TYPE: 1 })
    assert.equal(dictRows.get('vr-2')?.isRemoved, true)
    assert.equal(dictRows.get('vr-1')?.kind, 'VISIT_REASON')
  })

  it('同日已 sync 過 → skip（無新 call — 掛 15 分鐘 tick 就係 nightly）', async () => {
    await syncDictionaries({ force: true, now: new Date('2026-08-23T05:00:00Z') }) // HK 2026-08-23 13:00
    calls.length = 0
    const r2 = await syncDictionaries({ now: new Date('2026-08-23T05:15:00Z') }) // 同 HK 日
    assert.deepEqual(r2.skipped.sort(), ['BOOKING_TYPE', 'VISIT_REASON'])
    const dictCalls = calls.filter((c) => c.path.includes('visit-reasons') || c.path.includes('booking-types'))
    assert.equal(dictCalls.length, 0)
  })

  it('0 行 → 留舊 cache（RECONSTRUCTED path 驗證前嘅安全網）', async () => {
    const prev = respond
    respond = (c) => {
      if (c.path.includes('/visit-reasons') || c.path.includes('/booking-types')) return { foo: 'bar' }
      return prev(c)
    }
    const r = await syncDictionaries({ force: true, now: new Date('2026-08-24T05:00:00Z') })
    assert.deepEqual(r.synced, {})
    assert.deepEqual(r.skipped.sort(), ['BOOKING_TYPE', 'VISIT_REASON'])
    assert.equal(dictRows.size, 0)
  })

  it('單條 fail → skipped + 另一條繼續', async () => {
    const prev = respond
    respond = (c) => {
      if (c.path.includes('/visit-reasons')) throw new Error('APRICOT_HTTP_500: boom')
      if (c.path.includes('/booking-types')) return [{ id: 'bt-1', code: 'T1', des: 'Consultation' }]
      return prev(c)
    }
    const r = await syncDictionaries({ force: true, now: new Date('2026-08-24T05:00:00Z') })
    assert.deepEqual(r.synced, { BOOKING_TYPE: 1 })
    assert.deepEqual(r.skipped, ['VISIT_REASON'])
  })
})
