/**
 * ★★★ 勤工獎「補鐘豁免」修復 + 午休超時加返（2026-08-20，拍板 b 逐日合併）回歸測試
 * 跑法: npx tsx --test src/lib/payroll-engine.bonus-makeup.test.ts
 * （Node 22 內建 test runner，同 payroll-engine.hourly-eowage.test.ts 一致）
 *
 * 背景：evaluateAttendanceBonus 之前撈 tb.dailyLate / tb.dailyEarly（原始值，冇扣補鐘），
 *   補鐘抵扣只係喺 netLate / netEarly 做 → 「補鐘豁免勤工」從來冇兌現。
 * 修復：改用 workData.lateRecords / earlyLeaveRecords（已剔補鐘日）
 *   ＋ 由 tb.timeAccountDetail 逐日合併 lunchLate（午休超時唔包喺 workData 入面）。
 *   ⚠️ 逐日合併，禁止 lump sum（late_is_cumulative=false 取最大單次會爆錶）。
 *
 * 覆蓋 MD §4 驗收：
 *   #1/#2/#3 早退 330 + 補足 330 → 勤工獎發返；時間帳戶完全冇變（仍扣 330）
 *   #5       早退無補鐘 → 仍然取消
 *   #6       完全乾淨 → 照發
 *   #7       只補 1 分鐘 → 仍豁免（§二 已知設計：逐日整日豁免，非按分鐘）
 *   #8       只午休超時 40 > 30 → 取消
 *   #9       遲到 20（有補鐘）+ 午休 20 → 只計 20 → 保住
 *   #10      遲到 20（無補鐘）+ 午休 20 → 計 40 → 取消
 *   #11      cumulative=false 逐日合併唔爆錶（3×15 取 max 15 保住）
 *   #12      cumulative=true 3×15 加總 45 → 取消
 *   #15      缺勤補鐘（ABSENT）→ 勤工獎判斷唔變
 *   #17      FORCE_ON / FORCE_OFF 仍然壓過自動判斷
 *   #14      preview 回歸：T1 完整 snapshot —— 除勤工獎相關欄外全部不變
 *            （完整生產 preview 逐 field diff = 老細部署後實測，見交付報告）
 *   #16      時薪唔行 evaluateAttendanceBonus → payroll-engine.hourly-eowage.test.ts 已覆蓋
 *
 * 時間帳戶不變性（#3）：除咗 via calculatePayrollWithRules，另直接 call
 *   calculateTimeBank（exported）斷言 netLate/netEarly/makeupMinutes/netOtThisMonth。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from './prisma'
import { calculatePayrollWithRules, calculateTimeBank } from './payroll-engine'

const EMP = 'emp-bonus-makeup-test'
const BONUS = 1500
const SALARY = 30000
const MONTH = new Date(Date.UTC(2026, 7, 15)) // 2026 年 8 月（任意月內日）

// ---- 時間工具（HKT）--------------------------------------------------------
// 更次 09:00–18:00 HKT = 01:00–10:00 UTC
// ★ P() 參數係【香港牆鐘時間】（同場景描述一致），轉 UTC instant（HKT = UTC+8）
//   同 Prisma 回傳一致用 Date 物件 —— calculateWorkedHours 直接
//   formatDate(p.punchTime)，傳 string 會 Invalid time value
const pad = (n: number) => String(n).padStart(2, '0')
const P = (day: number, h: number, m = 0): Date =>
  new Date(Date.UTC(2026, 7, day, h, m) - 8 * 3600 * 1000)

// ---- 場景 -------------------------------------------------------------------
type HM = [number, number]
interface Scn {
  days: number[]                                            // 排更日子
  in?: Record<number, HM>                                   // 上班卡（預設 09:00）
  out?: Record<number, HM>                                  // 落班卡（預設 18:00）
  lunch?: Record<number, [number, number, number, number]>  // [LS h, LS m, LE h, LE m]
  absent?: number[]                                         // 排更但冇打卡
  makeup?: Array<{ day: number; minutes: number; targetType: string | null }>
  cumulative?: boolean                                      // late_is_cumulative（預設 true）
  override?: 'FORCE_ON' | 'FORCE_OFF' | null
}

const state: { shifts: any[]; punches: any[]; makeup: any[] } = {
  shifts: [], punches: [], makeup: [],
}

let _pid = 0
const punch = (day: number, type: string, h: number, m = 0) => ({
  id: `p${++_pid}`,
  employeeId: EMP,
  clinicId: 'c1',
  punchType: type,
  punchTime: P(day, h, m),
  void: null,
})

const mkShift = (day: number) => ({
  id: `s-${day}`,
  employeeId: EMP,
  clinicId: 'c1',
  secondaryClinicId: null,
  date: new Date(`2026-08-${pad(day)}T00:00:00.000Z`),
  startTime: new Date(`2026-08-${pad(day)}T01:00:00.000Z`),
  endTime: new Date(`2026-08-${pad(day)}T10:00:00.000Z`),
  status: 'SCHEDULED',
  template: null, // 無 template → 照扣午飯
})

function setup(scn: Scn) {
  state.shifts = scn.days.map(mkShift)
  const punches: any[] = []
  for (const d of scn.days) {
    if (scn.absent?.includes(d)) continue
    const [ih, im] = scn.in?.[d] ?? [9, 0]
    punches.push(punch(d, 'CLOCK_IN', ih, im))
    const l = scn.lunch?.[d]
    if (l) punches.push(punch(d, 'LUNCH_START', l[0], l[1]), punch(d, 'LUNCH_END', l[2], l[3]))
    const [oh, om] = scn.out?.[d] ?? [18, 0]
    punches.push(punch(d, 'CLOCK_OUT', oh, om))
  }
  state.punches = punches
  state.makeup = (scn.makeup ?? []).map((m, i) => ({
    id: `m${i}`,
    employeeId: EMP,
    type: 'MAKEUP',
    date: new Date(P(m.day, 12)),
    minutes: m.minutes,
    targetType: m.targetType,
    note: null,
  }))
}

const config = (cumulative = true): any => ({
  base_type: 'monthly',
  monthly_salary: SALARY,
  deduction_rate: 1,
  modifiers: {
    lunch_break: { enabled: true, defaultMinutes: 60, minMinutes: 30 },
    attendance_bonus: {
      amount: BONUS,
      cancel_if: { late_minutes_exceed: 30, late_is_cumulative: cumulative },
    },
  },
})

// ---- fake prisma delegate（唔真連 DB）----------------------------------------
type Any = any
const saved: Record<string, Any> = {}
const fakes: Record<string, Any> = {
  employee: { findUnique: async () => ({ id: EMP, name: 'Test', clinics: [] }) },
  shift: { findMany: async () => state.shifts },
  punchRecord: {
    findMany: async () => state.punches,
    findFirst: async () => null, // 上月無活動 → carriedFrom 0
  },
  punchCorrection: { findMany: async () => [] },
  hKPublicHoliday: { findMany: async () => [], count: async () => 0 },
  leaveRequest: { findMany: async () => [] },
  timeBank: { findFirst: async () => null, upsert: async () => ({}) },
  timeBankEntry: {
    findMany: async (args: any) => (args?.where?.type === 'MAKEUP' ? state.makeup : []),
    findFirst: async () => null,
  },
  expenseEntry: { findMany: async () => [] },
  consultationRevenue: { findFirst: async () => null },
  // ★ calculateTimeBank 由 DB payRule 讀 lunch_break/OT 門檻（唔係傳入嘅 config）
  //   → 要返 active rule + configJson，lunchLate 先會計
  payRule: {
    findFirst: async () => ({
      id: 'rule-test',
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

before(() => {
  for (const k of Object.keys(fakes)) {
    saved[k] = (prisma as Any)[k]
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})

after(() => {
  for (const k of Object.keys(saved)) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
})

const run = (scn: Scn) => {
  setup(scn) // ★ 每個場景必須先 setup —— fakes 讀 module-level state，唔 setup 會撈到上一個 test 嘅數據
  return calculatePayrollWithRules(EMP, MONTH, null, config(scn.cumulative), {
    attendanceBonusOverride: scn.override ?? null,
  })
}

const tb = async (scn: Scn) => {
  setup(scn)
  return calculateTimeBank(EMP, MONTH, { negative_carry: 'reset' }, prisma as any)
}

describe('勤工獎補鐘豁免 + 午休超時（拍板 b 逐日合併）', () => {
  // #1/#2/#3/#14 — 早退 330 補足 330：勤工獎發返，帳戶完全冇變
  it('#1/#3/#14 早退330+補足330 → 勤工獎發返；時間帳戶仍扣330；非勤工欄不變', async () => {
    setup({ days: [3], out: { 3: [12, 30] }, makeup: [{ day: 3, minutes: 330, targetType: 'EARLY_LEAVE' }] })

    // ★★★ 時間帳戶完全冇變（仍扣 330）—— 直接查 calculateTimeBank
    const t = await calculateTimeBank(EMP, MONTH, { negative_carry: 'reset' }, prisma as any)
    assert.equal(t.earlyLeaveMinutes, 330, '原始早退 330')
    assert.equal(t.makeupMinutes, 330, '補鐘消耗 330')
    assert.equal(t.makeupEarlyMinutes, 330)
    assert.equal(t.netEarlyMinutes, 0, 'netEarly 被補鐘抵銷')
    assert.equal(t.netLateMinutes, 0)
    assert.equal(t.netDeficitMinutes, 0)
    assert.equal(t.netOtThisMonth, -330, '帳戶淨值仍係 −330（扣 330）')
    assert.equal(t.owedMinutes, 330, '拖欠仍係 330')

    // ★★★ 勤工獎由 $0 變返正常，且冇「超過 30 分鐘門檻」
    const r = await calculatePayrollWithRules(EMP, MONTH, null, config(true))
    assert.equal(r.attendanceBonus, BONUS, '勤工獎發返')
    assert.equal(r.attendanceBonusCancelled, false)
    assert.equal(r.attendanceBonusReason, undefined, '唔應該有取消原因（#2）')
    assert.equal(r.detail.attendanceBonus, BONUS)

    // #14 preview 回歸 snapshot：除勤工獎相關欄外全部唔變
    // ★ workedHours 會扣 totalLunchDeductMinutes（無 LS/LE 卡 → 扣 default 60）：210−60=150min=2.5h
    assert.equal(r.basePay, SALARY, '底薪唔變')
    assert.equal(r.deduction, 0, '無缺勤扣款（早退唔係缺勤）')
    assert.equal(r.otPay, 0, '無 OT')
    assert.equal(r.absentDays, 0)
    assert.equal(r.leaveDays, 0)
    assert.equal(r.workedHours, 2.5, '09:00–12:30 = 210min − 60 lunch = 2.5h')
    const d = r.detail as any
    assert.equal(d.baseType, 'monthly')
    assert.equal(d.scheduledDays, 1)
    assert.equal(d.actualAttendanceDays, 1)
    assert.equal(d.absentDays, 0)
    assert.deepEqual(d.lateRecords, [], '補鐘日已剔走')
    assert.equal(d.grossPay, SALARY + BONUS, 'grossPay = 底薪 + 勤工獎')
    assert.equal(d.netPay, SALARY + BONUS, 'netPay 同 grossPay（無 MPF）')
    assert.equal(d.rawTotal, SALARY + BONUS)
  })

  // #5 — 早退無補鐘：仍然取消（最重要回歸）
  it('#5 早退330無補鐘 → 勤工獎仍然取消', async () => {
    const r = await run({ days: [3], out: { 3: [12, 30] } })
    assert.equal(r.attendanceBonus, 0)
    assert.equal(r.attendanceBonusCancelled, true)
    assert.match(r.attendanceBonusReason ?? '', /30分鐘門檻/)
    const t = await tb({ days: [3], out: { 3: [12, 30] } })
    assert.equal(t.netEarlyMinutes, 330, '帳戶照扣 330')
    assert.equal(t.netOtThisMonth, -330)
  })

  // #6 — 完全乾淨：照發（最重要回歸）
  it('#6 完全乾淨（遲到/早退/午休超時全無）→ 勤工獎照發', async () => {
    const r = await run({ days: [3, 4], lunch: { 3: [12, 0, 13, 0], 4: [12, 0, 13, 0] } })
    assert.equal(r.attendanceBonus, BONUS)
    assert.equal(r.attendanceBonusCancelled, false)
    assert.equal(r.attendanceBonusReason, undefined)
    const t = await tb({ days: [3, 4], lunch: { 3: [12, 0, 13, 0], 4: [12, 0, 13, 0] } })
    assert.equal(t.lateMinutes, 0)
    assert.equal(t.earlyLeaveMinutes, 0)
    assert.equal(t.lunchLateMinutes, 0)
    assert.equal(t.dailyLate.length, 0)
    assert.equal(t.timeAccountDetail.length, 0, '無任何異常 → 無逐日明細')
    assert.equal(r.workedHours, 16, '兩日各 (540 span − 60 lunch) = 480min → 16h')
  })

  // #7 — 只補 1 分鐘仍豁免整日（§二 已知設計：逐日整日豁免，非按分鐘）
  it('#7 早退330只補1分 → 勤工獎仍豁免（已知設計，帳戶照扣330）', async () => {
    const r = await run({ days: [3], out: { 3: [12, 30] }, makeup: [{ day: 3, minutes: 1, targetType: 'EARLY_LEAVE' }] })
    assert.equal(r.attendanceBonus, BONUS, '補 1 分鐘都豁免整日（§二 已知設計）')
    assert.equal(r.attendanceBonusCancelled, false)
    const t = await tb({ days: [3], out: { 3: [12, 30] }, makeup: [{ day: 3, minutes: 1, targetType: 'EARLY_LEAVE' }] })
    assert.equal(t.makeupMinutes, 1)
    assert.equal(t.netEarlyMinutes, 329, '帳戶按分鐘：淨早退 329')
    assert.equal(t.netOtThisMonth, -330, '帳戶總扣仍係 330（1 + 329）')
  })

  // #8 — 只午休超時 40 > 30：取消
  it('#8 只午休超時40分（無遲到）→ 取消（40 > 30）', async () => {
    const r = await run({ days: [3], lunch: { 3: [12, 0, 13, 40] } })
    assert.equal(r.attendanceBonus, 0)
    assert.equal(r.attendanceBonusCancelled, true)
    assert.match(r.attendanceBonusReason ?? '', /40/)
    const t = await tb({ days: [3], lunch: { 3: [12, 0, 13, 40] } })
    assert.equal(t.lunchLateMinutes, 40)
    assert.equal(t.lateMinutes, 40, '午休超時計入 lateMinutes（帳戶）')
  })

  // #9 — 遲到20（有補鐘）+ 午休20 → 只計 20 → 保住（修復核心）
  it('#9 遲到20有補鐘+午休20 → 只計20 → 保住', async () => {
    const scn = {
      days: [3],
      in: { 3: [9, 20] as HM },
      lunch: { 3: [12, 0, 13, 20] as [number, number, number, number] },
      makeup: [{ day: 3, minutes: 20, targetType: 'LATE' as const }],
    }
    const r = await run(scn)
    assert.equal(r.attendanceBonus, BONUS, '遲到 20 被補鐘剔走，只剩午休 20 ≤ 30 → 保住')
    assert.equal(r.attendanceBonusCancelled, false)
    const t = await tb(scn)
    assert.equal(t.lateMinutes, 40, '帳戶：遲到20 + 午休20')
    assert.equal(t.makeupLateMinutes, 20)
    assert.equal(t.netLateMinutes, 20, '帳戶按分鐘：淨遲到 20（午休20 無補鐘機制 → 照扣）')
    assert.equal(t.netOtThisMonth, -40, '帳戶總扣仍係原始 40（20 補鐘 + 20 淨遲到；規則① 永遠扣足原始分鐘）')
  })

  // #10 — 遲到20（無補鐘）+ 午休20 → 40 → 取消
  it('#10 遲到20無補鐘+午休20 → 40 → 取消', async () => {
    const scn = { days: [3], in: { 3: [9, 20] as HM }, lunch: { 3: [12, 0, 13, 20] as [number, number, number, number] } }
    const r = await run(scn)
    assert.equal(r.attendanceBonus, 0)
    assert.equal(r.attendanceBonusCancelled, true)
    assert.match(r.attendanceBonusReason ?? '', /40/)
  })

  // #11 — cumulative=false：3 日各 15 分午休超時 → 逐日合併取 max 15 → 保住（防 lump sum 爆錶）
  it('#11 cumulative=false 三日各15午休超時 → max 15 保住（逐日合併唔爆錶）', async () => {
    const scn = {
      days: [3, 5, 7],
      lunch: { 3: [12, 0, 13, 15] as [number, number, number, number], 5: [12, 0, 13, 15] as [number, number, number, number], 7: [12, 0, 13, 15] as [number, number, number, number] },
      cumulative: false,
    }
    const r = await run(scn)
    assert.equal(r.attendanceBonus, BONUS, 'max(15,15,15)=15 ≤ 30 → 保住（lump sum 會係 45 爆錶）')
    assert.equal(r.attendanceBonusCancelled, false)
    const t = await tb(scn)
    assert.equal(t.lunchLateMinutes, 45)
  })

  // #12 — cumulative=true：3 日各 15 分 → 加總 45 → 取消
  it('#12 cumulative=true 三日各15分 → 45 > 30 取消', async () => {
    const scn = {
      days: [3, 5, 7],
      lunch: { 3: [12, 0, 13, 15] as [number, number, number, number], 5: [12, 0, 13, 15] as [number, number, number, number], 7: [12, 0, 13, 15] as [number, number, number, number] },
      cumulative: true,
    }
    const r = await run(scn)
    assert.equal(r.attendanceBonus, 0)
    assert.equal(r.attendanceBonusCancelled, true)
    assert.match(r.attendanceBonusReason ?? '', /45/)
  })

  // #15 — 缺勤補鐘（ABSENT）：勤工獎判斷唔變（缺勤唔入 late/early，照走另一條分支）
  it('#15 缺勤+ABSENT補鐘480 → 勤工獎照發（ABSENT 唔影響遲到/早退判斷）', async () => {
    const scn = {
      days: [3, 5],
      absent: [3],
      lunch: { 5: [12, 0, 13, 0] as [number, number, number, number] },
      makeup: [{ day: 3, minutes: 480, targetType: 'ABSENT' }],
    }
    const r = await run(scn)
    assert.equal(r.attendanceBonus, BONUS, 'ABSENT 補鐘唔計入遲到/早退 → 勤工獎照發')
    assert.equal(r.attendanceBonusCancelled, false)
    assert.equal(r.absentDays, 0, '已扣OT鐘 → 唔計缺勤')
    const t = await tb(scn)
    assert.equal(t.makeupAbsentMinutes, 480)
    assert.equal(t.lateMinutes, 0)
    assert.equal(t.earlyLeaveMinutes, 0)
    assert.equal(t.netOtThisMonth, -480, '帳戶：ABSENT 補鐘额外扣 480（規則③，原有行為）')
  })

  // #17 — 人手覆蓋仍然壓過自動判斷
  it('#17a FORCE_OFF 壓過自動「發放」→ 人手取消', async () => {
    const r = await run({
      days: [3], in: { 3: [9, 20] as HM }, lunch: { 3: [12, 0, 13, 20] as [number, number, number, number] },
      makeup: [{ day: 3, minutes: 20, targetType: 'LATE' }],
      override: 'FORCE_OFF',
    })
    assert.equal(r.attendanceBonus, 0)
    assert.equal(r.attendanceBonusCancelled, true)
    assert.equal(r.attendanceBonusReason, '人手取消')
  })

  it('#17b FORCE_ON 壓過自動「取消」→ 人手發放', async () => {
    const r = await run({ days: [3], out: { 3: [12, 30] }, override: 'FORCE_ON' })
    assert.equal(r.attendanceBonus, BONUS)
    assert.equal(r.attendanceBonusCancelled, false)
    assert.equal(r.attendanceBonusReason, '人手發放')
  })
})
