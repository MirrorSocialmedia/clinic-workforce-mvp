/**
 * ★ PL 標記零下游影響證明（2026-08-21）—— MD §五 驗收 ★★★ #13
 * 跑法: npx tsx --test src/lib/payroll-engine.pl-marker.test.ts
 *
 * 場景：月薪 30000 + 勤工獎 1500；2026-08：
 *   - 08-03 (一) 排更 09:00–18:00，正常打卡
 *   - 08-05 (三) REST_DAY（員工自請休息日）—— isEmployeeRequested 前後各跑一次
 *   - 08-07 (五) ANNUAL_LEAVE 一日（paid）
 * 斷言：isEmployeeRequested=false 同 =true 嘅【完整 payroll 結果逐 field 一致】
 *   （deepEqual 全 object —— 唔係揀幾個欄睇，係全部欄）
 * 另附 sanity 斷言確認場景非空（有假、有工時、有獎金）。
 *
 * 原理：engine 所有 leaveRequest.findMany 嘅 select/include 都冇 isEmployeeRequested
 *   → 該欄根本唔會傳入 engine 邏輯；呢個測試用 fake 主動把欄帶入回傳，
 *   即使有漏網讀取，deepEqual 都會爆。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from './prisma'
import { calculatePayrollWithRules } from './payroll-engine'

const EMP = 'emp-pl-marker-test'
const BONUS = 1500
const SALARY = 30000
const MONTH = new Date(Date.UTC(2026, 7, 15)) // 2026 年 8 月

// ---- 時間工具（HKT = UTC+8）----------------------------------------------------
const P = (day: number, h: number, m = 0): Date =>
  new Date(Date.UTC(2026, 7, day, h, m) - 8 * 3600 * 1000)

// ---- 場景數據 -------------------------------------------------------------------
// ★ 同一組假期，唯一差異係 REST_DAY 筆嘅 isEmployeeRequested（true/false）
const mkLeaves = (isEmployeeRequested: boolean) => [
  {
    id: 'lr-rest',
    employeeId: EMP,
    clinicId: 'c1',
    status: 'APPROVED',
    startDate: new Date('2026-08-05T00:00:00.000Z'),
    endDate: new Date('2026-08-05T00:00:00.000Z'),
    isEmployeeRequested, // ★ 唯一变量
    leaveType: { id: 'lt-rest', name: '休息日', isPaid: true, systemKey: 'REST_DAY', cancelsBonus: false, color: '#d1d5db' },
  },
  {
    id: 'lr-annual',
    employeeId: EMP,
    clinicId: 'c1',
    status: 'APPROVED',
    startDate: new Date('2026-08-07T00:00:00.000Z'),
    endDate: new Date('2026-08-07T00:00:00.000Z'),
    isEmployeeRequested,
    leaveType: { id: 'lt-annual', name: '年假', isPaid: true, systemKey: 'ANNUAL_LEAVE', cancelsBonus: false, color: '#93c5fd' },
  },
]

const state = { leaves: mkLeaves(false) }

const fakes: Record<string, any> = {
  employee: { findUnique: async () => ({ id: EMP, name: 'PL Test', clinics: [] }) },
  shift: {
    findMany: async () => [
      {
        id: 's-3', employeeId: EMP, clinicId: 'c1', secondaryClinicId: null,
        date: new Date('2026-08-03T00:00:00.000Z'),
        startTime: new Date('2026-08-03T01:00:00.000Z'),
        endTime: new Date('2026-08-03T10:00:00.000Z'),
        status: 'SCHEDULED', template: null,
      },
    ],
  },
  punchRecord: {
    findMany: async () => [
      { id: 'p1', employeeId: EMP, clinicId: 'c1', punchType: 'CLOCK_IN', punchTime: P(3, 9, 0), void: null },
      { id: 'p2', employeeId: EMP, clinicId: 'c1', punchType: 'CLOCK_OUT', punchTime: P(3, 18, 0), void: null },
    ],
    findFirst: async () => null,
  },
  punchCorrection: { findMany: async () => [] },
  hKPublicHoliday: { findMany: async () => [], count: async () => 0 },
  leaveRequest: {
    // ★ fake 照 where 過濾，同 production prisma 行為一致
    findMany: async (args: any) => {
      const w = args?.where ?? {}
      let out = state.leaves
      const key = w.leaveType?.systemKey
      if (key) out = out.filter((l: any) => l.leaveType?.systemKey === key)
      return out
    },
  },
  timeBank: { findFirst: async () => null, upsert: async () => ({}) },
  timeBankEntry: { findMany: async () => [], findFirst: async () => null },
  expenseEntry: { findMany: async () => [] },
  consultationRevenue: { findFirst: async () => null },
  payRule: {
    findFirst: async () => ({
      id: 'rule-pl-test',
      employeeId: EMP,
      isActive: true,
      configJson: {
        base_type: 'monthly',
        modifiers: {
          lunch_break: { enabled: true, defaultMinutes: 60, minMinutes: 30 },
          overtime: { ot_min_minutes: 0, ot_round_minutes: 0 },
        },
      },
    }),
  },
}

const saved: Record<string, any> = {}
before(() => {
  for (const k of Object.keys(fakes)) {
    saved[k] = (prisma as any)[k]
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})
after(() => {
  for (const k of Object.keys(saved)) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
})

const config = () => ({
  base_type: 'monthly' as const,
  monthly_salary: SALARY,
  deduction_rate: 1,
  modifiers: {
    lunch_break: { enabled: true, defaultMinutes: 60, minMinutes: 30 },
    attendance_bonus: {
      amount: BONUS,
      cancel_if: { late_minutes_exceed: 30, late_is_cumulative: true },
    },
  },
})

const run = (isEmployeeRequested: boolean) => {
  state.leaves = mkLeaves(isEmployeeRequested)
  return calculatePayrollWithRules(EMP, MONTH, null, config())
}

describe('★★★ #13 計糧 preview 標記前後逐 field 一致（純標示零下游影響）', () => {
  it('REST_DAY 員工自請標記 true ↔ false：完整結果 deepEqual', async () => {
    const baseline = await run(false)
    const marked = await run(true)

    // ★★★ 全 object 逐 field 一致（JSON 序列化再比，確保無隱藏 prototype / undefined 差異）
    assert.deepEqual(JSON.parse(JSON.stringify(marked)), JSON.parse(JSON.stringify(baseline)))

    // sanity：場景非空（有工時、有假期、有獎金）—— 避免「两边都係空 object」嘅假陽性
    assert.equal(baseline.basePay, SALARY, '底薪在場')
    assert.ok(baseline.workedHours > 0, '有實做工時')
    assert.equal(baseline.attendanceBonus, BONUS, '勤工獎在場')
    const d = baseline.detail as any
    const allLeaveDays = (d.approvedLeaveDays ?? d.leaveDays ?? 0)
    assert.ok(allLeaveDays >= 1, '假期記錄有被 engine 讀到（場景非空）')
  })
})
