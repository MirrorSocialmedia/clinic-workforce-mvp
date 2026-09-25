/**
 * cwi-final S5-4（F4）：hold TTL 兩段式 + claim 先查 PatientIndex（T816–T819）
 *
 * 全 mock：fake prisma（monkey-patch prisma + basePrisma）+ setTestCallFn
 * （唔打真 Apricot）+ setApricotLockClientFactoryForTest（fake lock）。
 * 覆蓋（spec §S5-4 逐字邏輯）：
 *   - T816：已有病人（PatientIndex 1 match 同 phoneHash）+ claim →
 *     Apricot payload 用 clinicPatient:{ id: apricotId }（唔開新檔）；
 *     ALLOW_NEW_PATIENT_WRITE=0 都照寫（舊病人唔受新客旗影響 — 前置檢查已拆）
 *   - T817：同號兩人（2 個 PatientIndex row 同 phoneHash）→
 *     skipped: ambiguous_patient + hold 留 HELD + 零 Apricot call
 *   - T818：ALLOW_NEW_PATIENT_WRITE=0 + 0 match → skipped: new_patient_disabled；
 *     flag ON + 0 match → 新病人 inline payload（regression guard）
 *   - T819：TTL 兩段式 — HELD 超 2×holdTimeoutHours → RELEASED + audit
 *     PROVIDER_HOLD_TTL_RELEASE（notes 零 PII）；1.5× 唔 RELEASED；
 *     冪等（重複 sweep 唔雙重 audit）
 *
 * 跑法: TZ=UTC npx tsx --test src/lib/bookable-slots-s5-4.test.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, basePrisma } from './prisma'
import { setApricotLockClientFactoryForTest } from './apricot/lock'
import { setTestCallFn, type WriteCallFn } from './apricot/write-booking'
import { maybeWriteApricot, sweepPastHolds, type ClinicSlotConfig } from './bookable-slots-service'
import { phoneHash } from './phone-hash'

type Any = any

// ── 固定常量 ─────────────────────────────────────────────────────────
const TEST_KEY = 'test-phone-hash-key'
const WA_ID = '85212345678' // HK WA = 電話（normalizePhone → 尾 8）
const APPT_DATE = '2026-12-01' // 遠未來日 — sweep past 組（日期已過/時段已過）0 命中
const NOW = new Date('2026-09-26T16:00:00.000Z') // 固定 now（deterministic；HK 2026-09-27 00:00）

const CLINIC: ClinicSlotConfig = {
  id: 'cl-t1',
  shortName: 'TKW',
  apricotClinicId: 'apr-clinic-1',
  capacityPerProvider: 3,
  leadTimeMin: 30,
  flowWindowDays: 30,
  holdTimeoutHours: 24,
}
const PROVIDER = { id: 'p-ho', name: 'Dr. Ho', apricotIds: ['prov-ho'] }

const CLAIM_INPUT = {
  slotKey: 'unused',
  patientWaId: WA_ID,
  patientName: '測試病人甲',
  source: 'whatsapp_flow',
  flowToken: 'flow-tok-s54',
  visitReasonId: 'vr-1',
  requestedBy: 'wa-inbox',
}

// ── fake Apricot call（同 write-booking.test.ts 慣例）────────────────
interface Call { path: string; method?: string; body?: any }
const calls: Call[] = []
let respond: (c: Call) => any = () => ({})
const mockCall: WriteCallFn = (path, init) => {
  const c: Call = { path, method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
  calls.push(c)
  return Promise.resolve(respond(c))
}

function overviewRaw(dateStr: string, providerId: string, openFrom = 900, openTo = 1200): Any {
  const [y, m, d] = dateStr.split('-').map(Number)
  const utc = (hkMin: number) => new Date(Date.UTC(y, m - 1, d, 0, 0) + hkMin * 60_000 - 8 * 3600_000).toISOString()
  return {
    [dateStr]: {
      appointments: {
        [providerId]: {
          practitionerOpenSchs: { timeSlots: [{ startTime: openFrom, endTime: openTo }] },
          bookingDetail: [{ bookingTime: utc(540), bookingEndTime: utc(570), bookingStatus: 0, isRemoved: false }],
        },
      },
    },
  }
}

// ── fake 狀態 ────────────────────────────────────────────────────────
const patientIndexRows: Any[] = []
const heldRows: Any[] = []
const writeLogs = new Map<string, Any>()
const auditCreates: Any[] = []
const auditMany: Any[] = []
let holdSeq = 0

function seedHold(over: Any = {}): Any {
  holdSeq += 1
  const row = {
    id: `hold-s54-${String(holdSeq).padStart(3, '0')}`,
    clinicId: CLINIC.id,
    providerId: PROVIDER.id,
    date: APPT_DATE,
    startMin: 600,
    endMin: 630,
    status: 'HELD',
    patientWaId: WA_ID,
    patientName: '測試病人甲',
    source: 'whatsapp_flow',
    flowToken: `flow-seed-${holdSeq}`,
    createdAt: new Date(NOW.getTime() - 2 * 3600_000), // 預設 2h 前（TTL 內）
    committedAt: null,
    apricotRef: null,
    ...over,
  }
  heldRows.push(row)
  return row
}

// ── fake prisma（txAware — write-booking 寫入路徑）───────────────────
const fakesPrisma: Any = {
  $queryRaw: async () => [{ locked: null }],
  bookingWriteLog: {
    findUnique: async ({ where }: Any) => writeLogs.get(where.idempotencyKey) ?? null,
    upsert: async ({ where, update, create }: Any) => {
      const key = where.idempotencyKey
      const existing = writeLogs.get(key)
      if (existing) Object.assign(existing, update)
      else {
        const row = { id: `log-${key}`, createdAt: new Date(), ...create }
        writeLogs.set(key, row)
      }
      return writeLogs.get(key)
    },
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
  appointmentIndex: { findFirst: async () => null },
  apricotPractitioner: { findMany: async () => [{ apricotId: 'prov-ho', providerId: PROVIDER.id, kind: 'PROVIDER' }] },
  apricotDictionary: {
    findFirst: async () => ({ syncedAt: NOW }),
    upsert: async ({ create }: Any) => create,
  },
  provider: { findMany: async () => [{ id: PROVIDER.id, name: PROVIDER.name }] },
  patientIndex: { upsert: async ({ create }: Any) => create },
  availabilityCache: {
    deleteMany: async () => ({ count: 0 }),
    createMany: async ({ data }: Any) => ({ count: data.length }),
  },
  clinic: { findUnique: async () => ({ id: CLINIC.id, apricotClinicId: CLINIC.apricotClinicId }) },
  $transaction: async (arg: Any) => (Array.isArray(arg) ? Promise.all(arg) : arg()),
}

// ── fake basePrisma（raw — service 讀路徑）───────────────────────────
const fakesBase: Any = {
  patientIndex: {
    findMany: async ({ where }: Any) =>
      patientIndexRows.filter((r) => r.phoneHash === where.phoneHash).slice(0, 2),
  },
  clinic: {
    findMany: async ({ where }: Any) =>
      [CLINIC].filter((c) => (where?.id ? c.id === where.id : true)),
  },
  providerHold: {
    findMany: async ({ where }: Any) => {
      // TTL 組形態：clinicId + status HELD + createdAt.lt
      if (where.createdAt) {
        return heldRows
          .filter((r) => r.clinicId === where.clinicId && r.status === 'HELD' && r.createdAt < where.createdAt.lt)
          .slice(0, 200)
          .map((r) => ({ id: r.id }))
      }
      // past 組形態（status HELD + OR）— seed 全遠未來日 → 0 命中
      return []
    },
    updateMany: async ({ where, data }: Any) => {
      let n = 0
      for (const r of heldRows) {
        const idMatch = where.id?.in ? where.id.in.includes(r.id) : true
        const statusMatch = where.status == null || r.status === where.status
        if (idMatch && statusMatch) {
          Object.assign(r, data)
          n += 1
        }
      }
      return { count: n }
    },
    update: async ({ where, data }: Any) => {
      const row = heldRows.find((r) => r.id === where.id)
      if (row) Object.assign(row, data)
      return row ?? {}
    },
  },
  auditLog: {
    create: async (args: Any) => {
      auditCreates.push(args.data)
      return {}
    },
    createMany: async (args: Any) => {
      auditMany.push(args.data)
      return { count: args.data.length }
    },
  },
}

let saved: [Any, string, Any][] = []
const envSaved: Record<string, string | undefined> = {}
before(() => {
  for (const k of ['APRICOT_WRITE', 'ALLOW_NEW_PATIENT_WRITE', 'PHONE_HASH_KEY', 'APRICOT_DEFAULT_VISIT_REASON_ID']) {
    envSaved[k] = process.env[k]
  }
  process.env.APRICOT_WRITE = '1'
  delete process.env.ALLOW_NEW_PATIENT_WRITE
  process.env.PHONE_HASH_KEY = TEST_KEY
  delete process.env.APRICOT_DEFAULT_VISIT_REASON_ID
  setTestCallFn(mockCall)
  setApricotLockClientFactoryForTest(async () => ({
    query: async (sql: string) => ({ rows: [{ locked: /try_advisory_lock/.test(sql) ? true : null }] }),
    release: () => {},
  }))
  for (const [obj, fakes] of [[prisma, fakesPrisma], [basePrisma, fakesBase]] as const) {
    for (const k of Object.keys(fakes)) {
      saved.push([obj, k, (obj as Any)[k]])
      Object.defineProperty(obj, k, { value: (fakes as Any)[k], configurable: true, writable: true })
    }
  }
})
after(() => {
  setTestCallFn(null)
  setApricotLockClientFactoryForTest(null)
  for (const [k, v] of Object.entries(envSaved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
})
beforeEach(() => {
  patientIndexRows.length = 0
  heldRows.length = 0
  writeLogs.clear()
  auditCreates.length = 0
  auditMany.length = 0
  calls.length = 0
  holdSeq = 0
  // 預設：checkClash 無衝突 / create 成功 / overview 有開診
  respond = (c) => {
    if (c.path.includes('checkClash')) return []
    if (c.path.endsWith('/booking-details') && c.method === 'POST') {
      return { id: 'apt-new-1', clinicPatient: { id: 'pat-apr-999', code: 'P0099' } }
    }
    if (c.path.startsWith('/services/aepsmsappt/api/appointments/getOverviewAppointments')) {
      const qs = new URLSearchParams(c.path.split('?')[1] ?? '')
      return overviewRaw(qs.get('startDate') ?? APPT_DATE, 'prov-ho')
    }
    if (c.path.includes('/visit-reasons')) return { list: [{ id: 'vr-1', code: '01', des: 'Follow-up', isRemoved: false }] }
    if (c.path.includes('/booking-types')) return { list: [] }
    return {}
  }
})

/** 攞最後一條 booking-details POST 嘅 body */
function lastCreateBody(): Any {
  const c = [...calls].reverse().find((c) => c.path.endsWith('/booking-details') && c.method === 'POST')
  assert.ok(c, '應該有 booking-details POST')
  return c.body
}

// ── T816：已有病人 → Apricot payload 用 apricotId（唔開新檔）──────────

describe('T816 S5-4②：已有病人（PatientIndex 1 match）→ 重用 apricotId', () => {
  it('claim → clinicPatient:{ id }（零 firstName/phoneNum）+ hold IN_APRICOT', async () => {
    // PatientIndex 行 — sync 寫入口徑（phoneHash 單號，同 phone-hash.ts）
    patientIndexRows.push({
      id: 'pi-1',
      patientApricotId: 'pat-apr-1',
      patientCode: 'P0001',
      patientName: '測試病人甲',
      phoneHash: phoneHash(WA_ID),
      lastSeenAt: NOW,
    })
    const hold = seedHold()
    // ★ ALLOW_NEW_PATIENT_WRITE=0 都照寫 — 舊病人唔受新客旗影響（:704 前置檢查已拆）
    delete process.env.ALLOW_NEW_PATIENT_WRITE

    const out = await maybeWriteApricot(CLINIC, PROVIDER, hold, CLAIM_INPUT)
    assert.equal(out.outcome, 'written')

    const body = lastCreateBody()
    assert.deepEqual(body.clinicPatient, { id: 'pat-apr-1' }) // ★ 重用檔案
    assert.equal('firstName' in body.clinicPatient, false)
    assert.equal('phoneNum' in body.clinicPatient, false)

    // hold → IN_APRICOT + apricotRef（service 內 update 已 await）
    assert.equal(hold.status, 'IN_APRICOT')
    assert.equal(hold.apricotRef, 'apt-new-1')
  })

  it('IN_APRICOT 已寫入態重放 → written（唔再查 PatientIndex / 零 Apricot call）', async () => {
    patientIndexRows.push({
      id: 'pi-1', patientApricotId: 'pat-apr-1', patientCode: 'P0001', patientName: '測試病人甲',
      phoneHash: phoneHash(WA_ID), lastSeenAt: NOW,
    })
    const hold = seedHold({ status: 'IN_APRICOT', apricotRef: 'apt-existing' })
    const out = await maybeWriteApricot(CLINIC, PROVIDER, hold, CLAIM_INPUT)
    assert.equal(out.outcome, 'written')
    assert.equal(calls.filter((c) => c.path.endsWith('/booking-details')).length, 0)
    assert.equal(hold.apricotRef, 'apt-existing')
  })
})

// ── T817：同號兩人 → ambiguous_patient（hold 留 HELD）────────────────

describe('T817 S5-4②：同號兩人（2 match 同 phoneHash）→ ambiguous_patient', () => {
  it('skipped: ambiguous_patient + hold 留 HELD + 零 Apricot call', async () => {
    patientIndexRows.push(
      { id: 'pi-1', patientApricotId: 'pat-apr-1', patientCode: 'P0001', patientName: '病人一', phoneHash: phoneHash(WA_ID), lastSeenAt: NOW },
      { id: 'pi-2', patientApricotId: 'pat-apr-2', patientCode: 'P0002', patientName: '病人二', phoneHash: phoneHash(WA_ID), lastSeenAt: NOW },
    )
    const hold = seedHold()
    process.env.ALLOW_NEW_PATIENT_WRITE = '1' // 就算新客旗開 — 同號多人都唔自動揀

    const out = await maybeWriteApricot(CLINIC, PROVIDER, hold, CLAIM_INPUT)
    assert.equal(out.outcome, 'skipped')
    assert.equal(out.reason, 'ambiguous_patient')
    assert.equal(calls.filter((c) => c.path.endsWith('/booking-details')).length, 0)
    assert.equal(hold.status, 'HELD') // ★ hold 留 HELD（前台補入路徑）
    assert.equal(hold.apricotRef, null)
  })
})

// ── T818：0 match — flag off → new_patient_disabled / on → inline ────

describe('T818 S5-4②：0 match（新病人）', () => {
  it('ALLOW_NEW_PATIENT_WRITE=0 → skipped: new_patient_disabled（hold 留 HELD，零 Apricot call）', async () => {
    const hold = seedHold()
    delete process.env.ALLOW_NEW_PATIENT_WRITE // 默認 off
    const out = await maybeWriteApricot(CLINIC, PROVIDER, hold, CLAIM_INPUT)
    assert.equal(out.outcome, 'skipped')
    assert.equal(out.reason, 'new_patient_disabled')
    assert.equal(calls.filter((c) => c.path.endsWith('/booking-details')).length, 0)
    assert.equal(hold.status, 'HELD')
  })

  it('ALLOW_NEW_PATIENT_WRITE=1 → 新病人 inline payload（regression guard）', async () => {
    const hold = seedHold()
    process.env.ALLOW_NEW_PATIENT_WRITE = '1'
    const out = await maybeWriteApricot(CLINIC, PROVIDER, hold, CLAIM_INPUT)
    assert.equal(out.outcome, 'written')
    const body = lastCreateBody()
    assert.equal(body.clinicPatient.firstName, '測試病人甲')
    assert.equal(body.clinicPatient.phoneNum, WA_ID)
    assert.equal(body.clinicPatient.referralType, 'OTHER')
    assert.equal(hold.status, 'IN_APRICOT')
  })

  it('patientName null → 預設「線上預約」', async () => {
    const hold = seedHold()
    process.env.ALLOW_NEW_PATIENT_WRITE = '1'
    const out = await maybeWriteApricot(CLINIC, PROVIDER, hold, { ...CLAIM_INPUT, patientName: null })
    assert.equal(out.outcome, 'written')
    assert.equal(lastCreateBody().clinicPatient.firstName, '線上預約')
  })
})

// ── T819：TTL 兩段式（2×holdTimeoutHours）────────────────────────────

describe('T819 S5-4①：hold TTL 兩段式', () => {
  it('HELD 超 2×holdTimeoutHours（48h+1h）→ RELEASED + audit PROVIDER_HOLD_TTL_RELEASE', async () => {
    const old = seedHold({ createdAt: new Date(NOW.getTime() - 49 * 3600_000) })
    const n = await sweepPastHolds(null, NOW)
    assert.equal(n, 1)
    assert.equal(old.status, 'RELEASED')
    const ttlAudits = auditMany.flatMap((batch) => batch).filter((a) => a.action === 'PROVIDER_HOLD_TTL_RELEASE')
    assert.equal(ttlAudits.length, 1)
    assert.equal(ttlAudits[0].entityId, old.id)
    // notes 零 PII — 淨 clinic id / hold id / holdTimeoutHours
    const notes = JSON.parse(ttlAudits[0].notes)
    assert.deepEqual(notes, { clinicId: CLINIC.id, holdId: old.id, holdTimeoutHours: 24 })
    for (const p of [WA_ID, '測試病人甲', 'patientWaId', 'patientName']) {
      assert.ok(!ttlAudits[0].notes.includes(p), `TTL audit notes 含 PII: ${p}`)
    }
  })

  it('1.5×holdTimeoutHours（36h）→ 唔 RELEASED（1× 警報側係 W — S5-11）', async () => {
    const mid = seedHold({ createdAt: new Date(NOW.getTime() - 36 * 3600_000) })
    const n = await sweepPastHolds(null, NOW)
    assert.equal(n, 0)
    assert.equal(mid.status, 'HELD')
    assert.equal(auditMany.length, 0)
    assert.equal(auditCreates.length, 0)
  })

  it('恰 2×（48h 整，createdAt = cutoff）→ 唔 RELEASED（lt 嚴格小於）', async () => {
    const exact = seedHold({ createdAt: new Date(NOW.getTime() - 48 * 3600_000) })
    const n = await sweepPastHolds(null, NOW)
    assert.equal(n, 0)
    assert.equal(exact.status, 'HELD')
  })

  it('冪等：sweep 兩度 → 只 RELEASED 一次 + audit 只一行（唔雙重）', async () => {
    seedHold({ createdAt: new Date(NOW.getTime() - 72 * 3600_000) })
    assert.equal(await sweepPastHolds(null, NOW), 1)
    assert.equal(await sweepPastHolds(null, NOW), 0)
    const ttlAudits = auditMany.flatMap((batch) => batch).filter((a) => a.action === 'PROVIDER_HOLD_TTL_RELEASE')
    assert.equal(ttlAudits.length, 1)
  })

  it('holdTimeoutHours=null → fallback 24h；per-clinic 各自 cutoff', async () => {
    // clinic A（本 fake 唯一 clinic）holdTimeoutHours=12 → cutoff 24h
    const realFindMany = fakesBase.clinic.findMany
    fakesBase.clinic.findMany = async ({ where }: Any) =>
      [CLINIC, { ...CLINIC, id: 'cl-t2', holdTimeoutHours: 12 }]
        .filter((c: Any) => (where?.id ? c.id === where.id : true))
    const a = seedHold({ clinicId: 'cl-t2', createdAt: new Date(NOW.getTime() - 25 * 3600_000) }) // >24h → cl-t2（12h×2）RELEASED
    const b = seedHold({ clinicId: CLINIC.id, createdAt: new Date(NOW.getTime() - 25 * 3600_000) }) // <48h → 留 HELD
    try {
      const n = await sweepPastHolds(null, NOW)
      assert.equal(n, 1)
      assert.equal(a.status, 'RELEASED')
      assert.equal(b.status, 'HELD')
    } finally {
      fakesBase.clinic.findMany = realFindMany
    }
  })

  it('clinicId 參數收窄：其他店舊 hold 唔郁', async () => {
    const realFindMany = fakesBase.clinic.findMany
    fakesBase.clinic.findMany = async ({ where }: Any) =>
      [{ ...CLINIC, id: 'cl-t2', holdTimeoutHours: 24 }].filter((c: Any) => (where?.id ? c.id === where.id : true))
    const other = seedHold({ clinicId: 'cl-t2', createdAt: new Date(NOW.getTime() - 100 * 3600_000) })
    try {
      const n = await sweepPastHolds(CLINIC.id, NOW) // 只掃 cl-t1
      assert.equal(n, 0)
      assert.equal(other.status, 'HELD')
    } finally {
      fakesBase.clinic.findMany = realFindMany
    }
  })
})
