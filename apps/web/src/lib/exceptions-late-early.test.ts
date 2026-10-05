/**
 * ★ cwm-exclist-20260928：遲到／早退「每張更一行」route 測試（spec §2.5 — 7 情境）
 * 跑法: npx tsx --test src/lib/exceptions-late-early.test.ts
 * 寫法跟 today-board.test.ts / timebank-makeup-batch-route.test.ts（override prisma，唔真連 DB），
 * 直接 call GET /api/payroll-runs/exceptions route。
 *
 * 覆蓋（口徑 = matchPunchesToShifts：最早上班卡、最遲落班卡、同店分更時間窗 —— 同計糧 calculateTimeBank 一致）：
 *   1  同日兩張落班卡 19:30、19:30（重複撳）      → 只有 1 行 EARLY_LEAVE，30 分
 *   2  同日兩張落班卡 19:00、20:05（先撳錯、後補撳）→ 0 行 EARLY_LEAVE（最遲落班卡冇早退），同計糧一致
 *   3  同日兩張上班卡 10:05、10:20                → 1 行 LATE，5 分
 *   4  同店分更 10–14、16–20；14:00 落、19:30 落   → 第二更 1 行早退 30 分；第一更冇
 *   5  原卡 19:30 + 獨立補登（punchRecordId null）19:30 → 1 行早退
 *   6  早退已有 MAKEUP 紀錄                        → 1 行，madeUp = true
 *   7  午休超時                                    → LATE lunchLate = true 照舊出現，唔受影響
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { prisma } from './prisma'
import { createToken } from './auth'
import { GET } from '../app/api/payroll-runs/exceptions/route'

type Any = any

// ---- fixtures ---------------------------------------------------------------
const D = '2026-09-01' // 固定過去日（收工檢查：endTime < now）
const PERIOD = '2026-09'
const c1 = 'c1'
const e1 = 'e1'

interface State {
  shifts: Any[]
  punches: Array<{ id: string; employeeId: string; clinicId: string; punchTime: Date; punchType: string; void: null }>
  corrections: Any[]
  payRules: Any[]
  timeBankEntries: Any[]
}

const fresh = (): State => ({ shifts: [], punches: [], corrections: [], payRules: [], timeBankEntries: [] })
let state: State = fresh()

const clinics = [{ id: c1, name: 'C1 診所' }]
const ownerUser = { tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null, clinics: [{ clinicId: c1 }] }

const empInclude = { id: e1, user: { name: 'TestWorker' }, clinics: [{ clinicId: c1, clinic: { id: c1, name: 'C1 診所' } }] }

const at = (hm: string) => new Date(`${D}T${hm}:00+08:00`)

const mkShift = (id: string, emp: string, start: string, end: string, opts: { clinic?: string; secondary?: string | null } = {}) => ({
  id, employeeId: emp,
  date: new Date(`${D}T00:00:00+08:00`), // HK 午夜（同 DB 儲存口徑）
  startTime: at(start), endTime: at(end),
  status: 'CONFIRMED',
  clinicId: opts.clinic ?? c1,
  secondaryClinicId: opts.secondary ?? null,
  templateId: null,
  template: null,
  employee: empInclude,
  clinic: { id: opts.clinic ?? c1, name: 'C1 診所' },
})

const mkPunch = (id: string, emp: string, clinic: string, time: string, punchType: string) =>
  ({ id, employeeId: emp, clinicId: clinic, punchTime: at(time), punchType, void: null as null })

// ---- where 過濾（cover route + getEffectivePunches + payroll-engine 三種呼叫口徑）----
const inOrEq = (v: Any, x: string) =>
  v === undefined || v === null ? true : (Array.isArray(v?.in) ? v.in.includes(x) : x === v)
const rangeOk = (t: Date, r: Any) =>
  !r ? true : (t.getTime() >= (r.gte ?? new Date(0)).getTime() && t.getTime() <= (r.lte ?? new Date(8.64e15)).getTime())
const statusOk = (s: string, w: Any) => {
  if (!w.status) return true
  if (typeof w.status === 'string') return s === w.status
  if (w.status.in) return w.status.in.includes(s)
  if (w.status.notIn) return !w.status.notIn.includes(s)
  if (w.status.not) return s !== w.status.not
  return true
}

const filterShifts = (w: Any) => state.shifts.filter(s =>
  rangeOk(s.date, w.date) && statusOk(s.status, w) && inOrEq(w.employeeId, s.employeeId) &&
  (w.OR ? w.OR.some((o: Any) =>
    (o.clinicId ? (Array.isArray(o.clinicId.in) ? o.clinicId.in.includes(s.clinicId) : s.clinicId === o.clinicId) : false) ||
    (o.secondaryClinicId ? (Array.isArray(o.secondaryClinicId.in) ? o.secondaryClinicId.in.includes(s.secondaryClinicId) : s.secondaryClinicId === o.secondaryClinicId) : false)) : true))

const filterPunches = (w: Any) => state.punches
  .filter(p => rangeOk(p.punchTime, w.punchTime) && inOrEq(w.employeeId, p.employeeId) && (!w.void || p.void === w.void.is))
  .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime())

const filterCorrections = (w: Any) => state.corrections.filter(c =>
  rangeOk(c.correctedTime, w.correctedTime) &&
  (!w.status || c.status === w.status) && inOrEq(w.employeeId, c.employeeId) && inOrEq(w.clinicId, c.clinicId))

const filterRules = (w: Any) => state.payRules
  .filter(r => inOrEq(w.employeeId, r.employeeId))
  .filter(r => w.isActive === undefined || r.isActive === w.isActive)
  .filter(r => !w.effectiveFrom?.lte || r.effectiveFrom.getTime() <= w.effectiveFrom.lte.getTime())
  .filter(r => !w.OR ? true : w.OR.some((o: Any) =>
    o.effectiveTo === null ? r.effectiveTo === null : r.effectiveTo !== null && r.effectiveTo.getTime() >= o.effectiveTo.gte.getTime()))
  .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.createdAt - a.createdAt)

const filterEntries = (w: Any) => state.timeBankEntries.filter(x =>
  (!w.type || x.type === w.type) &&
  (w.targetType === undefined ? true : x.targetType === w.targetType) &&
  rangeOk(x.date, w.date) && inOrEq(w.employeeId, x.employeeId))

// ---- fake prisma（全部讀；timeBank.upsert 若被調用 = 測試 fixture 有問題，直接炸）----
const fakes: Record<string, Any> = {
  user: {
    findUnique: async (args: Any) => (args?.where?.id === 'u1' ? ownerUser : null),
  },
  employee: {
    findMany: async (args: Any) => (args?.where?.id?.in ?? []).map((id: string) =>
      ({ id, status: 'ACTIVE', attendanceExempt: false, user: { name: 'TestWorker' } })),
    findUnique: async () => null,
  },
  employeeClinic: { findMany: async () => [] },
  clinic: { findMany: async () => clinics },
  shift: { findMany: async (args: Any) => filterShifts(args?.where ?? {}) },
  shiftTemplate: { findMany: async () => [] },
  punchRecord: {
    findMany: async (args: Any) => filterPunches(args?.where ?? {}).map(p => ({ ...p, employee: empInclude })),
    findFirst: async (args: Any) => filterPunches(args?.where ?? {})[0] ?? null,
    count: async () => 0,
  },
  punchCorrection: {
    findMany: async (args: Any) => filterCorrections(args?.where ?? {}).map(c => ({ ...c, employee: empInclude })),
  },
  payRule: {
    findMany: async (args: Any) => filterRules(args?.where ?? {}),
    findFirst: async (args: Any) => filterRules(args?.where ?? {})[0] ?? null,
  },
  leaveRequest: { findMany: async () => [] },
  leaveType: { findUnique: async () => null, findFirst: async () => null },
  leaveBalance: { findUnique: async () => null },
  holidayOtAdjustment: {
    findMany: async () => [],
    aggregate: async () => ({ _count: { _all: 0 }, _sum: { deductMinutes: 0 } }),
  },
  timeBank: {
    findFirst: async () => null,
    findUnique: async () => null,
    upsert: async () => { throw new Error('timeBank.upsert 唔應該被調用（fixture 冇上月活動）') },
  },
  timeBankLedgerSnapshot: { findUnique: async () => null },
  timeBankEntry: {
    findMany: async (args: Any) => filterEntries(args?.where ?? {}),
    findFirst: async (args: Any) => filterEntries(args?.where ?? {})[0] ?? null,
    aggregate: async () => ({ _count: { _all: 0 }, _sum: { minutes: 0 } }),
  },
  hKPublicHoliday: { findMany: async () => [] },
  payrollRun: { findMany: async () => [] },
  payrollItem: { findMany: async () => [] },
  consultationRevenue: { findMany: async () => [] },
  expenseEntry: { findMany: async () => [] },
  resignSettlement: { findMany: async () => [] },
  auditLog: { create: async () => ({ id: 'noop' }), findMany: async () => [] },
  // timeBankCacheKey 嘅 TimeBankDirty watermark（engine L105）—— 零行 = dirtyFp '0'
  $queryRaw: async () => [],
}

const saved: Record<string, Any> = {}
before(() => {
  for (const k of Object.keys(fakes)) {
    saved[k] = (prisma as Any)[k]
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})
after(() => {
  for (const k of Object.keys(fakes)) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
})
beforeEach(() => { state = fresh() })

// ---- helpers -----------------------------------------------------------------
const token = createToken({ userId: 'u1', role: 'OWNER', clinics: [c1], tokenVersion: 1 })

const call = () => GET(new NextRequest(`http://localhost/api/payroll-runs/exceptions?periodMonth=${PERIOD}`, {
  headers: { cookie: `session=${token}` },
}) as any)

const rows = (b: Any, type: string) => b.exceptions.filter((e: Any) => e.type === type)

describe('exceptions 遲到／早退 per-shift（cwm-exclist-20260928 spec §2.5）', () => {
  it('1 同日兩張落班卡 19:30、19:30（重複撳）→ 只有 1 行 EARLY_LEAVE，30 分', async () => {
    state.shifts = [mkShift('s1', e1, '09:00', '20:00')]
    state.punches = [
      mkPunch('p-in', e1, c1, '09:00', 'CLOCK_IN'),
      mkPunch('p-out-1', e1, c1, '19:30', 'CLOCK_OUT'),
      mkPunch('p-out-2', e1, c1, '19:30', 'CLOCK_OUT'),
    ]
    const res = await call()
    assert.equal(res.status, 200)
    const b = await res.json()
    const early = rows(b, 'EARLY_LEAVE')
    assert.equal(early.length, 1)
    assert.equal(early[0].earlyMinutes, 30)
    assert.equal(early[0].date, D)
    assert.equal(early[0].clinicName, 'C1 診所')
  })

  it('2 同日兩張落班卡 19:00、20:05（先撳錯、後補撳）→ 0 行 EARLY_LEAVE（最遲落班卡冇早退），同計糧一致', async () => {
    state.shifts = [mkShift('s1', e1, '09:00', '20:00')]
    state.punches = [
      mkPunch('p-in', e1, c1, '09:00', 'CLOCK_IN'),
      mkPunch('p-out-1', e1, c1, '19:00', 'CLOCK_OUT'),
      mkPunch('p-out-2', e1, c1, '20:05', 'CLOCK_OUT'),
    ]
    const res = await call()
    assert.equal(res.status, 200)
    const b = await res.json()
    assert.equal(rows(b, 'EARLY_LEAVE').length, 0)
  })

  it('3 同日兩張上班卡 10:05、10:20 → 1 行 LATE，5 分', async () => {
    state.shifts = [mkShift('s1', e1, '10:00', '18:00')]
    state.punches = [
      mkPunch('p-in-1', e1, c1, '10:05', 'CLOCK_IN'),
      mkPunch('p-in-2', e1, c1, '10:20', 'CLOCK_IN'),
      mkPunch('p-out', e1, c1, '18:00', 'CLOCK_OUT'),
    ]
    const res = await call()
    assert.equal(res.status, 200)
    const b = await res.json()
    const late = rows(b, 'LATE')
    assert.equal(late.length, 1)
    assert.equal(late[0].lateMinutes, 5)
    assert.equal(late[0].lunchLate, undefined)
  })

  it('4 同店分更 10–14 / 16–20：14:00 落、19:30 落 → 第二更 1 行早退 30 分；第一更冇', async () => {
    state.shifts = [mkShift('s1', e1, '10:00', '14:00'), mkShift('s2', e1, '16:00', '20:00')]
    state.punches = [
      mkPunch('p-out-1', e1, c1, '14:00', 'CLOCK_OUT'),
      mkPunch('p-out-2', e1, c1, '19:30', 'CLOCK_OUT'),
    ]
    const res = await call()
    assert.equal(res.status, 200)
    const b = await res.json()
    const early = rows(b, 'EARLY_LEAVE')
    assert.equal(early.length, 1)
    assert.equal(early[0].earlyMinutes, 30)
    assert.equal(early[0].date, D)
    // detail 帶第二更嘅收工時間 20:00（唔係第一更嘅 14:00）
    assert.match(early[0].detail, /20:00/)
    assert.ok(!early[0].detail.includes('14:00'), '唔應該用第一更嘅收工時間')
  })

  it('5 原卡 19:30 + 獨立補登（punchRecordId null）19:30 → 1 行早退', async () => {
    state.shifts = [mkShift('s1', e1, '09:00', '20:00')]
    state.punches = [
      mkPunch('p-in', e1, c1, '09:00', 'CLOCK_IN'),
      mkPunch('p-out', e1, c1, '19:30', 'CLOCK_OUT'),
    ]
    state.corrections = [{
      id: 'corr-1', employeeId: e1, clinicId: c1, punchType: 'CLOCK_OUT',
      correctedTime: at('19:30'), punchRecordId: null, status: 'APPROVED', reason: '漏打補登',
    }]
    const res = await call()
    assert.equal(res.status, 200)
    const b = await res.json()
    const early = rows(b, 'EARLY_LEAVE')
    assert.equal(early.length, 1)
    assert.equal(early[0].earlyMinutes, 30)
    // 獨立補登本身照出 CORRECTION 行（唔受影響）
    assert.ok(rows(b, 'CORRECTION').length >= 1)
  })

  it('6 早退已有 MAKEUP 紀錄 → 1 行，madeUp = true', async () => {
    state.shifts = [mkShift('s1', e1, '09:00', '20:00')]
    state.punches = [
      mkPunch('p-in', e1, c1, '09:00', 'CLOCK_IN'),
      mkPunch('p-out', e1, c1, '19:30', 'CLOCK_OUT'),
    ]
    state.timeBankEntries = [{
      id: 'tb-1', employeeId: e1, type: 'MAKEUP', targetType: 'EARLY_LEAVE',
      date: new Date('2026-09-01T00:00:00Z'), minutes: -30,
    }]
    const res = await call()
    assert.equal(res.status, 200)
    const b = await res.json()
    const early = rows(b, 'EARLY_LEAVE')
    assert.equal(early.length, 1)
    assert.equal(early[0].earlyMinutes, 30)
    assert.equal(early[0].madeUp, true)
  })

  it('7 午休超時 → LATE lunchLate = true 照舊出現，唔受影響', async () => {
    state.shifts = [mkShift('s1', e1, '09:00', '18:00')]
    state.payRules = [{
      employeeId: e1,
      configJson: JSON.stringify({ modifiers: { lunch_break: { enabled: true, defaultMinutes: 60, minMinutes: 30 } } }),
      isActive: true,
      effectiveFrom: new Date('2026-01-01T00:00:00+08:00'), effectiveTo: null, createdAt: 1,
    }]
    state.punches = [
      mkPunch('p-in', e1, c1, '09:00', 'CLOCK_IN'),
      mkPunch('p-ls', e1, c1, '12:00', 'LUNCH_START'),
      mkPunch('p-le', e1, c1, '13:30', 'LUNCH_END'),
      mkPunch('p-out', e1, c1, '18:00', 'CLOCK_OUT'),
    ]
    const res = await call()
    assert.equal(res.status, 200)
    const b = await res.json()
    const late = rows(b, 'LATE')
    assert.equal(late.length, 1)
    assert.equal(late[0].lunchLate, true)
    assert.equal(late[0].lateMinutes, 30)
  })
})
