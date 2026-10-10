/**
 * ★ cwm-otbackpay-20261010：OT 門檻設錯（15 分鐘）少計嘅 OT
 *   跑法: TZ=UTC npx tsx --test src/lib/timebank-ot-backpay.test.ts
 *   fake db（同 payroll-engine.bonus-makeup.test.ts 同一套路）—— 零 DB 依賴。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { calculateTimeBank } from './payroll-engine'
import { findOtBackpay, otBackpayDays, otBackpayNote, otBackpayTag } from './timebank-ot-backpay'

const EMP = 'emp-otbp'
const P = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 7, day, h, m) - 8 * 3600 * 1000) // HKT 牆鐘 → UTC
const pad = (n: number) => String(n).padStart(2, '0')
const shift = (day: number) => ({
  id: `s-${day}`, employeeId: EMP, clinicId: 'c1', secondaryClinicId: null, status: 'SCHEDULED', template: null,
  date: new Date(`2026-08-${pad(day)}T00:00:00.000Z`),
  startTime: new Date(`2026-08-${pad(day)}T01:00:00.000Z`), // 09:00 HKT
  endTime: new Date(`2026-08-${pad(day)}T10:00:00.000Z`),   // 18:00 HKT
})
let pid = 0
const punch = (day: number, type: string, h: number, m = 0) => ({ id: `p${++pid}`, employeeId: EMP, clinicId: 'c1', punchType: type, punchTime: P(day, h, m), void: null })

// 8/3 落班 18:10（OT 10）、8/4 落班 18:20（OT 20）、8/5 準時
const shifts = [3, 4, 5].map(shift)
const punches = [
  punch(3, 'CLOCK_IN', 9), punch(3, 'CLOCK_OUT', 18, 10),
  punch(4, 'CLOCK_IN', 9), punch(4, 'CLOCK_OUT', 18, 20),
  punch(5, 'CLOCK_IN', 9), punch(5, 'CLOCK_OUT', 18),
]
const db: any = {
  payRule: {
    findFirst: async () => ({
      id: 'r1', employeeId: EMP, isActive: true,
      configJson: { base_type: 'monthly', modifiers: { lunch_break: { enabled: false }, overtime: { ot_min_minutes: 15, ot_round_minutes: 0 } } },
    }),
    findMany: async () => [],
  },
  shift: { findMany: async () => shifts },
  punchRecord: { findMany: async () => punches, findFirst: async () => null },
  punchCorrection: { findMany: async () => [] },
  leaveRequest: { findMany: async () => [] },
  holidayOtAdjustment: { findMany: async () => [] },
  lunchDeductOverride: { findMany: async () => [] },
  timeBank: { findFirst: async () => null, upsert: async () => ({}) },
  timeBankEntry: { findMany: async () => [], findFirst: async () => null, aggregate: async () => ({ _count: { _all: 0 }, _sum: { minutes: 0 } }) },
  timeBankLedgerSnapshot: { findUnique: async () => null },
}
const AUG = new Date('2026-08-01T00:00:00+08:00')

test('門檻 15：10 分鐘嗰日唔計；override 0：照計（正常計糧唔傳 override，行為不變）', async () => {
  const withRule = await calculateTimeBank(EMP, AUG, {}, db)
  const noLimit = await calculateTimeBank(EMP, AUG, {}, db, 0, { otMinMinutes: 0 })
  assert.strictEqual(withRule.otMinutes, 20)
  assert.strictEqual(noLimit.otMinutes, 30)
})

test('findOtBackpay：逐日搵出少計 —— 只有 8/3 +10', async () => {
  const r = await findOtBackpay(db, EMP, '2026-08', 15)
  assert.deepStrictEqual(r.days, [{ date: '2026-08-03', credited: 0, correct: 10, diff: 10 }])
  assert.strictEqual(r.totalMinutes, 10)
})

test('otBackpayDays：holidayOt 一齊計；同額／減少嘅日子唔列；按日期排', () => {
  const credited = [{ date: '2026-08-09', clockOutOt: 30 }, { date: '2026-08-02', holidayOt: 0 }]
  const correct = [{ date: '2026-08-09', clockOutOt: 30 }, { date: '2026-08-02', holidayOt: 12 }, { date: '2026-08-01', clockOutOt: 5 }]
  assert.deepStrictEqual(otBackpayDays(credited, correct), [
    { date: '2026-08-01', credited: 0, correct: 5, diff: 5 },
    { date: '2026-08-02', credited: 0, correct: 12, diff: 12 },
  ])
  assert.deepStrictEqual(otBackpayDays(correct, credited), []) // 反方向（減少）唔會變成負數補回
})

test('note 帶防重複標記', () => {
  const n = otBackpayNote('2026-08', 15, [{ date: '2026-08-03', credited: 0, correct: 10, diff: 10 }])
  assert.ok(n.startsWith(otBackpayTag('2026-08')))
  assert.match(n, /1 日共 10 分鐘/)
})
