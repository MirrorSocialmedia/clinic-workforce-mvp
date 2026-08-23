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
 *   - rescheduleBooking：102→create；新單 fail → ERROR:create_after_102 + 唔自動 rollback
 *   - syncDictionaries：upsert / 每日 skip / 0 行留舊
 *   - lock busy → APRICOT_BUSY
 *   - 🔴 PII：hostile response（塞 PII 欄）→ console 零內文
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../prisma'
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
  },
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
  provider: { findMany: async () => [{ apricotId: 'prov-1', name: 'Dr. T' }] },
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
  for (const obj of [prisma]) {
    for (const k of Object.keys(fakes) as (keyof typeof fakes)[]) {
      saved.push([obj, k, (obj as Any)[k]])
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
  }
})
after(() => {
  setTestCallFn(null)
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
    // 🔴 零 PII：log row 只有白名單欄
    assert.deepEqual(Object.keys(log).sort(), ['action', 'apricotApptId', 'createdAt', 'id', 'idempotencyKey', 'requestedBy', 'status'])
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

// ── reschedule ───────────────────────────────────────────────────────

describe('rescheduleBooking', () => {
  const base = {
    oldApricotApptId: 'apt-old',
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

  it('成功：同一把 lock 內 102 → create；兩日各 refresh 一次', async () => {
    const r = await rescheduleBooking(base)
    assert.equal(r.oldApptId, 'apt-old')
    assert.equal(r.newApptId, 'apt-new-1')
    assert.equal(r.dayRefreshed, true)

    // 順序：先 102，後 create
    const idx102 = calls.findIndex((c) => c.path.includes('updateStatus?status=102'))
    const idxCreate = calls.findIndex((c) => c.path.endsWith('/booking-details') && c.method === 'POST')
    assert.ok(idx102 >= 0 && idxCreate > idx102, '應該 102 先、create 後')

    // 兩日各一次 overview（startDate=endDate 分別 = OLD_DATE / DATE）
    const ovs = calls.filter((c) => c.path.includes('getOverviewAppointments'))
    assert.equal(ovs.length, 2)
    const dates = ovs.map((c) => new URLSearchParams(c.path.split('?')[1]).get('startDate')).sort()
    assert.deepEqual(dates, [OLD_DATE, DATE])

    // WriteLog 底：102 標記 + CREATE OK + RESCHEDULE OK
    const rows = [...writeLogs.values()]
    assert.ok(rows.some((l) => l.status === 'OK:102_marked' && l.apricotApptId === 'apt-old'))
    assert.ok(rows.some((l) => l.action === 'CREATE' && l.status === 'OK' && l.apricotApptId === 'apt-new-1'))
    assert.ok(rows.some((l) => l.action === 'RESCHEDULE' && l.status === 'OK' && l.apricotApptId === 'apt-new-1'))
  })

  it('新單 fail → ERROR:create_after_102 + ALERT，唔自動 rollback（MD §6 已知殘留態）', async () => {
    const prev = respond
    respond = (c) => {
      if (c.path.endsWith('/booking-details') && c.method === 'POST') throw new Error('APRICOT_HTTP_422: slot filled')
      return prev(c)
    }
    await assert.rejects(rescheduleBooking(base), (e: Any) => e instanceof ApricotWriteError && e.code === 'APRICOT_HTTP_422')

    // 殘留底
    const after102 = [...writeLogs.values()].find((l) => l.status === 'ERROR:create_after_102')
    assert.ok(after102, 'ERROR:create_after_102 底缺失')
    assert.equal(after102.apricotApptId, 'apt-old')
    // ALERT 行
    assert.match(ALL_LOG(), /reschedule 殘留態/)
    // 唔自動 rollback：無 -7 / remove call 打去舊單
    const rollbackCalls = calls.filter((c) => c.path.includes('updateStatus?status=-7') || c.path.includes('/remove'))
    assert.equal(rollbackCalls.length, 0, '唔准自動 rollback')
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
