/**
 * ═══════════════════════════════════════════════════════════
 *  計糧測試工具 test-payroll.ts（v3 — 對齊最新制度）
 *  只改 SCENARIO 區塊，然後：
 *    DATABASE_URL="postgresql://clinic:devpass@localhost:5432/clinic_test" npx tsx test-payroll.ts
 *
 *  v3 對齊：9小時=1天換假、rest_days [6,0]、OT不自動換假（只結餘額）、
 *          時間帳戶 = 結轉 + OT − 補鐘 − 淨(遲到+早退)、系統假期類型自動確保
 * ═══════════════════════════════════════════════════════════
 */
import { PrismaClient } from '@prisma/client'
import { calculatePayrollWithRules, calculateTimeBank } from './src/lib/payroll-engine'
import { invalidateTimeBankFrom } from './src/lib/punch-query'

const prisma = new PrismaClient()

// ╔═══════════════ ★★★ 只改這裡 ★★★ ═══════════════╗
const SCENARIO = {
  month: '2026-07',
  monthlySalary: 15000,
  clinicName: '銅鑼灣診所',

  rule: {
    attendanceBonus: 500,
    cancelBonusIfLateOver: 30,   // 遲到累計>30分取消勤工
    cancelBonusIfAbsent: true,
    otHoursPerLeaveDay: 9,       // ★ 9小時=1天（老闆手動兌換用）
    restDays: [6, 0],            // ★ 週末休息日（每月發放額度用）
    mpfEnabled: true,
    mpfRate: 0.05,
  },

  // 每天：shift 排班、in/out 打卡（null=沒打）
  days: [
    { date: '2026-07-01', shift: ['09:00','18:00'], in: '09:00', out: '18:00' }, // 正常
    { date: '2026-07-02', shift: ['09:00','18:00'], in: '09:20', out: '18:00' }, // 遲到20
    { date: '2026-07-03', shift: ['09:00','18:00'], in: '09:00', out: '20:00' }, // OT 120
    { date: '2026-07-06', shift: ['09:00','18:00'], in: null,    out: null    }, // 缺勤
    { date: '2026-07-07', shift: ['09:00','18:00'], in: '09:00', out: '22:00' }, // OT 240
    { date: '2026-07-08', shift: ['09:00','18:00'], in: '09:15', out: '17:30' }, // 遲15+早退30
  ],
  // 預期：OT=360、遲到=35、早退=30、deficit=65
  // 時間帳戶 = 0(carry) + 360 − 0(補鐘) − 65 = +295 → 可換0天(不足540)
  // 勤工：遲到35>30 或 缺勤 → 取消
}
// ╚═══════════════ ★★★ 改到這裡 ★★★ ═══════════════╝

// ╔═══════════════ ★★★ S17: OT 最低門檻測試 ★★★ ════════════════╗
const SCENARIO_S17 = {
  month: '2026-07',
  monthlySalary: 15000,
  clinicName: '銅鑼灣診所',
  otMinMinutes: 15,  // 低於15分鐘的OT不計

  rule: {
    attendanceBonus: 0,
    cancelBonusIfLateOver: 30,
    cancelBonusIfAbsent: false,
    otHoursPerLeaveDay: 9,
    restDays: [6, 0],
    mpfEnabled: false,
    mpfRate: 0.05,
  },

  // 每天：shift 排班、in/out 打卡（null=沒打）
  days: [
    { date: '2026-07-01', shift: ['09:00','18:00'], in: '09:00', out: '18:10' }, // OT 10 → 不計(<15)
    { date: '2026-07-02', shift: ['09:00','18:00'], in: '09:00', out: '18:20' }, // OT 20 → 全數計(≥15)
    { date: '2026-07-03', shift: ['09:00','18:00'], in: '09:00', out: '18:14' }, // OT 14 → 不計(<15)
    { date: '2026-07-06', shift: ['09:00','18:00'], in: '09:00', out: '18:30' }, // OT 30 → 全數計(≥15)
  ],
  // 預期：OT=50(20+30)、遲到=0、早退=0
  // 時間帳戶 = 50
}
// ╚═══════════════ ★★★ S17 改到這裡 ★★★ ═══════════════╝

// ╔═══════════════ ★★★ S18: 早退超標取消勤工 ★★★ ════════════════╗
const SCENARIO_S18 = {
  month: '2026-07',
  monthlySalary: 15000,
  clinicName: '銅鑼灣診所',

  rule: {
    attendanceBonus: 500,
    cancelBonusIfLateOver: 30,
    cancelBonusIfAbsent: false,
    otHoursPerLeaveDay: 9,
    restDays: [6, 0],
    mpfEnabled: false,
    mpfRate: 0.05,
  },

  // 早退40分鐘（正常18:00下班，17:20打卡）→ 超標30 → 勤工取消
  days: [
    { date: '2026-07-06', shift: ['09:00','18:00'], in: '09:00', out: '17:20' },
  ],
}
// ╚═══════════════ ★★★ S18 改到這裡 ★★★ ════════════════╝

function dt(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+08:00`)
}

async function main() {
  console.log('\n═══ 計糧測試 v3 ═══\n')

  // 0. 確保系統假期類型（休息日發放/OT兌換依賴）
  for (const t of [
    { systemKey: 'REST_DAY', name: '休息日', isPaid: true, color: '#4a4a4a' },
    { systemKey: 'ANNUAL_LEAVE', name: '年假', isPaid: true, color: '#27ae60' },
    { systemKey: 'OT_LEAVE', name: 'OT補假', isPaid: true, color: '#8e44ad' },
  ]) {
    const ex = await prisma.leaveType.findUnique({ where: { systemKey: t.systemKey } }).catch(() => null)
    if (!ex) { await prisma.leaveType.create({ data: t as any }); console.log(`➕ 補建系統類型 ${t.name}`) }
  }

  // 1. 診所
  const clinic = await prisma.clinic.findFirst({ where: { name: SCENARIO.clinicName } })
  if (!clinic) { console.error(`❌ 找不到診所「${SCENARIO.clinicName}」`); return }

  // 2. 測試員工
  let user = await prisma.user.findFirst({ where: { phone: 'TEST0001' } })
  if (!user) user = await prisma.user.create({
    data: { name: '測試員工', phone: 'TEST0001', password: 'x', role: 'EMPLOYEE' } })
  let emp = await prisma.employee.findFirst({ where: { userId: user.id } })
  if (!emp) emp = await prisma.employee.create({ data: { userId: user.id, joinDate: new Date('2025-01-01') } })
  await prisma.employeeClinic.upsert({
    where: { employeeId_clinicId: { employeeId: emp.id, clinicId: clinic.id } },
    update: {}, create: { employeeId: emp.id, clinicId: clinic.id } }).catch(() => {})

  // 3. 清該月舊資料（同月重測不用先 reset；跨月/徹底請跑 reset-test-data）
  const monthStart = new Date(`${SCENARIO.month}-01T00:00:00+08:00`)
  const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
  await prisma.punchVoid.deleteMany({ where: { punchRecord: { employeeId: emp.id } } }).catch(() => {})
  await prisma.punchRecord.deleteMany({ where: { employeeId: emp.id, punchTime: { gte: monthStart, lt: monthEnd } } })
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})
  await prisma.shift.deleteMany({ where: { employeeId: emp.id, date: { gte: monthStart, lt: monthEnd } } })
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: emp.id, date: { gte: monthStart, lt: monthEnd } } }).catch(() => {})
  await prisma.timeBank.deleteMany({ where: { employeeId: emp.id, periodMonth: { gte: monthStart, lt: monthEnd } } }).catch(() => {})

  // 4. 排班 + 打卡
  for (const d of SCENARIO.days) {
    await prisma.shift.create({ data: {
      employeeId: emp.id, clinicId: clinic.id,
      date: dt(d.date, '00:00'),
      startTime: dt(d.date, d.shift[0]), endTime: dt(d.date, d.shift[1]),
      status: 'CONFIRMED', createdBy: user.id } })
    if (d.in) await prisma.punchRecord.create({ data: {
      employeeId: emp.id, clinicId: clinic.id, punchTime: dt(d.date, d.in),
      punchType: 'CLOCK_IN', source: 'QR_DYNAMIC', tokenValid: true } })
    if (d.out) await prisma.punchRecord.create({ data: {
      employeeId: emp.id, clinicId: clinic.id, punchTime: dt(d.date, d.out),
      punchType: 'CLOCK_OUT', source: 'QR_DYNAMIC', tokenValid: true } })
  }

  // 5. 薪酬規則（新格式；OT mode time_off 但不自動換假，只結餘額）
  const config = {
    base_type: 'monthly',
    monthly_salary: SCENARIO.monthlySalary,
    modifiers: {
      attendance_bonus: { amount: SCENARIO.rule.attendanceBonus, cancel_if: {
        late_minutes_exceed: SCENARIO.rule.cancelBonusIfLateOver,
        late_is_cumulative: true, any_unplanned_leave: true,
        any_absence: SCENARIO.rule.cancelBonusIfAbsent } },
      overtime: { mode: 'time_off', hours_per_leave_day: SCENARIO.rule.otHoursPerLeaveDay },
      working_days: { basis: 'scheduled', rest_days: SCENARIO.rule.restDays, count_public_holidays: true },
      deduction: { basis: 'statutory' },
      mpf: { enabled: SCENARIO.rule.mpfEnabled, rate: SCENARIO.rule.mpfRate, min: 7100, max: 30000 },
    },
  }

  // 6. 跑引擎
  const result = await calculatePayrollWithRules(emp.id, monthStart, clinic.id, config as any)

  // 7. 結果
  console.log('─── 計糧結果 ───')
  console.log(`底薪:          $${result.basePay?.toFixed(2)}`)
  console.log(`缺勤:          ${result.absentDays} 天 → 扣 $${result.deduction?.toFixed(2)}`)
  console.log(`勤工獎:        $${result.attendanceBonus?.toFixed(2)}${result.attendanceBonusCancelled ? `（取消: ${result.attendanceBonusReason}）` : ''}`)
  console.log(`應付:          $${result.totalPayable?.toFixed(2)}`)
  const tb = (result.detail as any)?.timebank || {}
  console.log('\n─── 時間銀行（分鐘） ───')
  console.log(`本月OT:        ${tb.otMinutes ?? '?'} 分`)
  console.log(`遲到:          ${tb.lateMinutes ?? '?'} 分 / 早退: ${tb.earlyLeaveMinutes ?? '?'} 分`)
  console.log(`補鐘:          ${tb.makeupMinutes ?? 0} 分`)
  console.log(`時間帳戶:      ${tb.timeAccountMinutes >= 0 ? '+' : ''}${tb.timeAccountMinutes ?? '?'} 分`)
  console.log(`可換假:        ${tb.convertibleLeaveDays ?? '?'} 天（老闆手動兌換，不自動）`)
  console.log('\n─── detail ───')
  console.log(JSON.stringify(result.detail, null, 2))

  // 8. 驗算
  console.log('\n─── 驗算 ───')
  let expOt = 0, expLate = 0, expEarly = 0
  for (const d of SCENARIO.days) {
    if (!d.in || !d.out) continue
    const sStart = dt(d.date, d.shift[0]).getTime(), sEnd = dt(d.date, d.shift[1]).getTime()
    const aIn = dt(d.date, d.in).getTime(), aOut = dt(d.date, d.out).getTime()
    if (aIn > sStart) expLate += Math.ceil((aIn - sStart) / 60000)
    if (aOut < sEnd) expEarly += Math.ceil((sEnd - aOut) / 60000)
    if (aOut > sEnd) expOt += Math.floor((aOut - sEnd) / 60000)
  }
  const expAccount = expOt - (expLate + expEarly)  // 本測試無補鐘無結轉
  console.log(`預期 OT=${expOt}分 遲到=${expLate}分 早退=${expEarly}分`)
  console.log(`預期時間帳戶 = ${expOt} − (${expLate}+${expEarly}) = ${expAccount >= 0 ? '+' : ''}${expAccount} 分`)
  console.log(`預期勤工: ${expLate > SCENARIO.rule.cancelBonusIfLateOver ? '取消(遲到超標)' : '看缺勤'}`)
  console.log(`對照引擎: 帳戶 ${tb.timeAccountMinutes}、OT ${tb.otMinutes} — ${tb.timeAccountMinutes === expAccount ? '✅ 一致' : '❌ 不一致，檢查公式'}`)
}

// ─── S17: OT 最低門檻測試 ───
async function runS17() {
  console.log('\n═══ S17: OT 最低門檻測試 ═══\n')

  const S = SCENARIO_S17
  const clinic = await prisma.clinic.findFirst({ where: { name: S.clinicName } })
  if (!clinic) { console.error(`❌ 找不到診所「${S.clinicName}」`); return }

  let user = await prisma.user.findFirst({ where: { phone: 'TEST_S17' } })
  if (!user) user = await prisma.user.create({
    data: { name: 'S17測試員工', phone: 'TEST_S17', password: 'x', role: 'EMPLOYEE' } })
  let emp = await prisma.employee.findFirst({ where: { userId: user.id } })
  if (!emp) emp = await prisma.employee.create({ data: { userId: user.id, joinDate: new Date('2025-01-01') } })
  await prisma.employeeClinic.upsert({
    where: { employeeId_clinicId: { employeeId: emp.id, clinicId: clinic.id } },
    update: {}, create: { employeeId: emp.id, clinicId: clinic.id } }).catch(() => {})

  // Clean old data
  const monthStart = new Date(`${S.month}-01T00:00:00+08:00`)
  const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)
  await prisma.punchVoid.deleteMany({ where: { punchRecord: { employeeId: emp.id } } }).catch(() => {})
  await prisma.punchRecord.deleteMany({ where: { employeeId: emp.id, punchTime: { gte: monthStart, lt: monthEnd } } })
  await prisma.shift.deleteMany({ where: { employeeId: emp.id, date: { gte: monthStart, lt: monthEnd } } })
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: emp.id, date: { gte: monthStart, lt: monthEnd } } }).catch(() => {})
  await prisma.timeBank.deleteMany({ where: { employeeId: emp.id, periodMonth: { gte: monthStart, lt: monthEnd } } }).catch(() => {})
  await prisma.payRule.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})

  // Create PayRule in DB — engine queries DB for ot_min_minutes
  await prisma.payRule.create({
    data: {
      employeeId: emp.id,
      payType: 'MONTHLY',
      isActive: true,
      effectiveFrom: new Date('2026-01-01'),
      configJson: JSON.stringify({
        base_type: 'monthly',
        monthly_salary: S.monthlySalary,
        modifiers: {
          overtime: {
            mode: 'time_off',
            hours_per_leave_day: S.rule.otHoursPerLeaveDay,
            ot_min_minutes: S.otMinMinutes,
          },
          working_days: {
            basis: 'scheduled',
            rest_days: S.rule.restDays,
            count_public_holidays: true,
          },
          deduction: { basis: 'statutory' },
        },
      }),
    },
  } as any)
  console.log(`✅ PayRule created (ot_min_minutes=${S.otMinMinutes})`)

  // Create shifts + punches
  for (const d of S.days) {
    await prisma.shift.create({ data: {
      employeeId: emp.id, clinicId: clinic.id,
      date: dt(d.date, '00:00'),
      startTime: dt(d.date, d.shift[0]), endTime: dt(d.date, d.shift[1]),
      status: 'CONFIRMED', createdBy: user.id } })
    if (d.in) await prisma.punchRecord.create({ data: {
      employeeId: emp.id, clinicId: clinic.id, punchTime: dt(d.date, d.in),
      punchType: 'CLOCK_IN', source: 'QR_DYNAMIC', tokenValid: true } })
    if (d.out) await prisma.punchRecord.create({ data: {
      employeeId: emp.id, clinicId: clinic.id, punchTime: dt(d.date, d.out),
      punchType: 'CLOCK_OUT', source: 'QR_DYNAMIC', tokenValid: true } })
  }

  // Run engine
  const config = {
    base_type: 'monthly',
    monthly_salary: S.monthlySalary,
    modifiers: {
      overtime: {
        mode: 'time_off',
        hours_per_leave_day: S.rule.otHoursPerLeaveDay,
        ot_min_minutes: S.otMinMinutes,
      },
      working_days: {
        basis: 'scheduled',
        rest_days: S.rule.restDays,
        count_public_holidays: true,
      },
      deduction: { basis: 'statutory' },
    },
  }
  const result = await calculatePayrollWithRules(emp.id, monthStart, clinic.id, config as any)

  // Results
  const tb = (result.detail as any)?.timebank || {}
  console.log(`\n─── S17 結果 ───`)
  console.log(`OT: ${tb.otMinutes ?? '?'} 分 (預期: 50 分 — 20+30, 10和14被門檻過濾)`)
  console.log(`時間帳戶: ${tb.timeAccountMinutes >= 0 ? '+' : ''}${tb.timeAccountMinutes ?? '?'} 分 (預期: +50)`)

  // Verify
  const otOk = tb.otMinutes === 50
  const accountOk = tb.timeAccountMinutes === 50
  console.log(`${otOk && accountOk ? '✅ S17 PASS' : '❌ S17 FAIL — 檢查 ot_min_minutes 門檻邏輯'}`)

  // Cleanup payRule
  await prisma.payRule.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})
}


// ─── S18: 早退超標取消勤工 ───
async function runS18() {
  console.log('\n═══ S18: 早退超標取消勤工 ═══\n')

  const S = SCENARIO_S18
  const clinic = await prisma.clinic.findFirst({ where: { name: S.clinicName } })
  if (!clinic) { console.error(`❌ 找不到診所「${S.clinicName}」`); return }

  let user = await prisma.user.findFirst({ where: { phone: 'TEST_S18' } })
  if (!user) user = await prisma.user.create({
    data: { name: 'S18測試員工', phone: 'TEST_S18', password: 'x', role: 'EMPLOYEE' } })
  let emp = await prisma.employee.findFirst({ where: { userId: user.id } })
  if (!emp) emp = await prisma.employee.create({ data: { userId: user.id, joinDate: new Date('2025-01-01') } })
  await prisma.employeeClinic.upsert({
    where: { employeeId_clinicId: { employeeId: emp.id, clinicId: clinic.id } },
    update: {}, create: { employeeId: emp.id, clinicId: clinic.id } }).catch(() => {})

  // Clean old data
  const monthStart = new Date(`${S.month}-01T00:00:00+08:00`)
  const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)
  await prisma.punchVoid.deleteMany({ where: { punchRecord: { employeeId: emp.id } } }).catch(() => {})
  await prisma.punchRecord.deleteMany({ where: { employeeId: emp.id, punchTime: { gte: monthStart, lt: monthEnd } } })
  await prisma.shift.deleteMany({ where: { employeeId: emp.id, date: { gte: monthStart, lt: monthEnd } } })
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: emp.id, date: { gte: monthStart, lt: monthEnd } } }).catch(() => {})
  await prisma.timeBank.deleteMany({ where: { employeeId: emp.id, periodMonth: { gte: monthStart, lt: monthEnd } } }).catch(() => {})

  // Create shifts + punches
  for (const d of S.days) {
    await prisma.shift.create({ data: {
      employeeId: emp.id, clinicId: clinic.id,
      date: dt(d.date, '00:00'),
      startTime: dt(d.date, d.shift[0]), endTime: dt(d.date, d.shift[1]),
      status: 'CONFIRMED', createdBy: user.id } })
    if (d.in) await prisma.punchRecord.create({ data: {
      employeeId: emp.id, clinicId: clinic.id, punchTime: dt(d.date, d.in),
      punchType: 'CLOCK_IN', source: 'QR_DYNAMIC', tokenValid: true } })
    if (d.out) await prisma.punchRecord.create({ data: {
      employeeId: emp.id, clinicId: clinic.id, punchTime: dt(d.date, d.out),
      punchType: 'CLOCK_OUT', source: 'QR_DYNAMIC', tokenValid: true } })
  }

  // Run engine
  const config = {
    base_type: 'monthly',
    monthly_salary: S.monthlySalary,
    modifiers: {
      attendance_bonus: { amount: S.rule.attendanceBonus, cancel_if: {
        late_minutes_exceed: S.rule.cancelBonusIfLateOver,
        late_is_cumulative: true, any_unplanned_leave: true,
        any_absence: S.rule.cancelBonusIfAbsent } },
      overtime: { mode: 'time_off', hours_per_leave_day: S.rule.otHoursPerLeaveDay },
      working_days: { basis: 'scheduled', rest_days: S.rule.restDays, count_public_holidays: true },
      deduction: { basis: 'statutory' },
    },
  }
  const result = await calculatePayrollWithRules(emp.id, monthStart, clinic.id, config as any)

  // Results
  const tb = (result.detail as any)?.timebank || {}
  console.log(`\n─── S18 結果 ───`)
  console.log(`勤工: $${result.attendanceBonus ?? '?'} ${result.attendanceBonusCancelled ? `（取消: ${result.attendanceBonusReason}）` : ''}`)
  console.log(`時間帳戶: ${tb.timeAccountMinutes >= 0 ? '+' : ''}${tb.timeAccountMinutes ?? '?'} 分 (預期: -40)`)

  // Verify
  const bonusCancelled = result.attendanceBonusCancelled === true
  const bonusZero = result.attendanceBonus === 0
  const accountOk = tb.timeAccountMinutes === -40
  const reasonOk = result.attendanceBonusReason?.includes('早退')
  console.log(`${bonusCancelled && bonusZero && accountOk && reasonOk ? '✅ S18 PASS' : '❌ S18 FAIL'}`)
}

// ─── S19: 店舖營業額獎金測試 ───
async function runS19() {
  console.log('\n═══ S19: 店舖營業額獎金測試 ═══\n')

  const S = SCENARIO_S18
  const clinic = await prisma.clinic.findFirst({ where: { name: S.clinicName } })
  if (!clinic) { console.error(`❌ 找不到診所「${S.clinicName}」`); return }

  let user = await prisma.user.findFirst({ where: { phone: 'TEST_S19' } })
  if (!user) user = await prisma.user.create({
    data: { name: 'S19測試員工', phone: 'TEST_S19', password: 'x', role: 'EMPLOYEE' } })
  let emp = await prisma.employee.findFirst({ where: { userId: user.id } })
  if (!emp) emp = await prisma.employee.create({ data: { userId: user.id, joinDate: new Date('2025-01-01') } })
  await prisma.employeeClinic.upsert({
    where: { employeeId_clinicId: { employeeId: emp.id, clinicId: clinic.id } },
    update: {}, create: { employeeId: emp.id, clinicId: clinic.id } }).catch(() => {})

  // Clean old data
  const monthStart = new Date(`${S.month}-01T00:00:00+08:00`)
  const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
  await prisma.punchVoid.deleteMany({ where: { punchRecord: { employeeId: emp.id } } }).catch(() => {})
  await prisma.punchRecord.deleteMany({ where: { employeeId: emp.id, punchTime: { gte: monthStart, lt: monthEnd } } })
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})
  await prisma.shift.deleteMany({ where: { employeeId: emp.id, date: { gte: monthStart, lt: monthEnd } } })
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: emp.id, date: { gte: monthStart, lt: monthEnd } } }).catch(() => {})
  await prisma.timeBank.deleteMany({ where: { employeeId: emp.id, periodMonth: { gte: monthStart, lt: monthEnd } } }).catch(() => {})

  // Create shifts + punches (normal attendance day)
  await prisma.shift.create({ data: {
    employeeId: emp.id, clinicId: clinic.id,
    date: dt('2026-07-06', '00:00'),
    startTime: dt('2026-07-06', '09:00'), endTime: dt('2026-07-06', '18:00'),
    status: 'CONFIRMED', createdBy: user.id } })
  await prisma.punchRecord.create({ data: {
    employeeId: emp.id, clinicId: clinic.id, punchTime: dt('2026-07-06', '09:00'),
    punchType: 'CLOCK_IN', source: 'QR_DYNAMIC', tokenValid: true } })
  await prisma.punchRecord.create({ data: {
    employeeId: emp.id, clinicId: clinic.id, punchTime: dt('2026-07-06', '18:00'),
    punchType: 'CLOCK_OUT', source: 'QR_DYNAMIC', tokenValid: true } })

  // Run engine with storeBonus = 1000
  const config = {
    base_type: 'monthly',
    monthly_salary: S.monthlySalary,
    modifiers: {
      attendance_bonus: { amount: S.rule.attendanceBonus, cancel_if: {
        late_minutes_exceed: S.rule.cancelBonusIfLateOver,
        late_is_cumulative: true, any_unplanned_leave: true,
        any_absence: S.rule.cancelBonusIfAbsent } },
      overtime: { mode: 'time_off', hours_per_leave_day: S.rule.otHoursPerLeaveDay },
      working_days: { basis: 'scheduled', rest_days: S.rule.restDays, count_public_holidays: true },
      deduction: { basis: 'statutory' },
      mpf: { enabled: true, rate: 0.05, min: 7100, max: 30000 },
    },
  }
  const result = await calculatePayrollWithRules(emp.id, monthStart, clinic.id, config as any, { storeBonus: 1000 })

  // Results
  const storeBonus = (result.detail as any)?.storeBonus ?? 0
  const grossPay = (result.detail as any)?.grossPay ?? 0
  const mpf = (result.detail as any)?.mpf ?? 0
  const expectedMpf = Math.round(grossPay * 0.05)

  console.log(`\n─── S19 結果 ───`)
  console.log(`店舖獎金: $${storeBonus} (預期: $1000)`)
  console.log(`GrossPay: $${grossPay}`)
  console.log(`MPF: $${mpf} (預期: $${expectedMpf} = GrossPay × 5%)`)

  // Verify
  const bonusOk = storeBonus === 1000
  const mpfOk = mpf === expectedMpf
  console.log(`${bonusOk && mpfOk ? '✅ S19 PASS' : '❌ S19 FAIL'}`)
}

// ─── S22: 初始化後跨月查詢含結轉（cache invalidation + TimeBankEntry fallback） ───
async function runS22() {
  console.log('\n═══ S22: 初始化後跨月查詢含結轉 ═══\n')

  const S = SCENARIO_S18
  const clinic = await prisma.clinic.findFirst({ where: { name: S.clinicName } })
  if (!clinic) { console.error(`❌ 找不到診所「${S.clinicName}」`); return }

  let user = await prisma.user.findFirst({ where: { phone: 'TEST_S22' } })
  if (!user) user = await prisma.user.create({
    data: { name: 'S22測試員工', phone: 'TEST_S22', password: 'x', role: 'EMPLOYEE' } })
  let emp = await prisma.employee.findFirst({ where: { userId: user.id } })
  if (!emp) emp = await prisma.employee.create({ data: { userId: user.id, joinDate: new Date('2025-01-01') } })
  await prisma.employeeClinic.upsert({
    where: { employeeId_clinicId: { employeeId: emp.id, clinicId: clinic.id } },
    update: {}, create: { employeeId: emp.id, clinicId: clinic.id } }).catch(() => {})

  // Clean ALL old data (June + July + beyond)
  const juneStart = new Date('2026-06-01T00:00:00+08:00')
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
  await prisma.punchVoid.deleteMany({ where: { punchRecord: { employeeId: emp.id } } }).catch(() => {})
  await prisma.punchRecord.deleteMany({ where: { employeeId: emp.id } })
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})
  await prisma.shift.deleteMany({ where: { employeeId: emp.id } })
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})
  await prisma.timeBank.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})

  // Step 1: June — create shift + punch (OT 60 分鐘)
  await prisma.shift.create({ data: {
    employeeId: emp.id, clinicId: clinic.id,
    date: dt('2026-06-06', '00:00'),
    startTime: dt('2026-06-06', '09:00'), endTime: dt('2026-06-06', '18:00'),
    status: 'CONFIRMED', createdBy: user.id } })
  await prisma.punchRecord.create({ data: {
    employeeId: emp.id, clinicId: clinic.id, punchTime: dt('2026-06-06', '09:00'),
    punchType: 'CLOCK_IN', source: 'QR_DYNAMIC', tokenValid: true } })
  await prisma.punchRecord.create({ data: {
    employeeId: emp.id, clinicId: clinic.id, punchTime: dt('2026-06-06', '19:00'),
    punchType: 'CLOCK_OUT', source: 'QR_DYNAMIC', tokenValid: true } })

  // Step 2: Run June payroll → calculates TimeBank, persists cache
  const juneStart2 = new Date('2026-06-01T00:00:00+08:00')
  const juneConfig = {
    base_type: 'monthly',
    monthly_salary: 15000,
    modifiers: {
      overtime: { mode: 'time_off', hours_per_leave_day: 9 },
      working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
      deduction: { basis: 'statutory' },
    },
  }
  const juneResult = await calculatePayrollWithRules(emp.id, juneStart2, clinic.id, juneConfig as any)
  const juneTb = (juneResult.detail as any)?.timebank || {}
  console.log(`六月 OT: ${juneTb.otMinutes} 分 (預期: 60)`)
  console.log(`六月帳戶: ${juneTb.timeAccountMinutes} 分 (預期: +60)`)

  // Step 3: Post-init adjustment — add INIT_ADJUST -6500 (simulating init-adjust API)
  const initAdjustMinutes = -6500
  await prisma.timeBankEntry.create({ data: {
    employeeId: emp.id, date: new Date('2026-06-01T00:00:00+08:00'),
    type: 'INIT_ADJUST', minutes: initAdjustMinutes,
    note: '測試初始化負帳', createdBy: 'test',
  }})

  // Step 4: Invalidate TimeBank cache from June onward (simulating API)
  await invalidateTimeBankFrom(emp.id, '2026-06-01', prisma)

  // Step 5: Calculate July — carriedFrom should include the init-adjust
  const julyDate = new Date('2026-07-01T00:00:00+08:00')
  // Create a July shift (no OT, just normal) so the month has activity
  await prisma.shift.create({ data: {
    employeeId: emp.id, clinicId: clinic.id,
    date: dt('2026-07-06', '00:00'),
    startTime: dt('2026-07-06', '09:00'), endTime: dt('2026-07-06', '18:00'),
    status: 'CONFIRMED', createdBy: user.id } })
  await prisma.punchRecord.create({ data: {
    employeeId: emp.id, clinicId: clinic.id, punchTime: dt('2026-07-06', '09:00'),
    punchType: 'CLOCK_IN', source: 'QR_DYNAMIC', tokenValid: true } })
  await prisma.punchRecord.create({ data: {
    employeeId: emp.id, clinicId: clinic.id, punchTime: dt('2026-07-06', '18:00'),
    punchType: 'CLOCK_OUT', source: 'QR_DYNAMIC', tokenValid: true } })

  const tbJuly = await calculateTimeBank(emp.id, julyDate, {}, prisma)
  console.log(`\n─── S22 結果 ───`)
  console.log(`七月 carriedFrom: ${tbJuly.carriedFrom} 分 (預期: -6440 = 60 + (-6500))`)
  console.log(`七月帳戶: ${tbJuly.timeAccountMinutes} 分 (預期: -6440 = carriedFrom + 0 OT)`)  
  console.log(`七月餘額: ${tbJuly.balance} 分 (預期: -6440)`)  

  // Verify
  const expectedCarriedFrom = 60 + initAdjustMinutes // 60 + (-6500) = -6440
  const carriedFromOk = tbJuly.carriedFrom === expectedCarriedFrom
  const accountOk = tbJuly.timeAccountMinutes === expectedCarriedFrom
  console.log(`${carriedFromOk && accountOk ? '✅ S22 PASS' : '❌ S22 FAIL'}`)
  if (!carriedFromOk) {
    console.log(`  carriedFrom got ${tbJuly.carriedFrom}, expected ${expectedCarriedFrom}`)
  }
  if (!accountOk) {
    console.log(`  timeAccountMinutes got ${tbJuly.timeAccountMinutes}, expected ${expectedCarriedFrom}`)
  }
}

async function runAll() {
  try { await main() } catch (e) { console.error('main failed:', e) }
  try { await runS17() } catch (e) { console.error('S17 failed:', e) }
  try { await runS18() } catch (e) { console.error('S18 failed:', e) }
  try { await runS19() } catch (e) { console.error('S19 failed:', e) }
  try { await runS20() } catch (e) { console.error('S20 failed:', e) }
  try { await runS21() } catch (e) { console.error('S21 failed:', e) }
  try { await runS22() } catch (e) { console.error('S22 failed:', e) }
  console.log('\n═══ 所有測試完成 ═══\n')
  await prisma.$disconnect()
}

// ─── S20: 初始化負帳 + 跨月結轉 ───
async function runS20() {
  console.log('\n═══ S20: 初始化負帳 + 跨月結轉 ═══\n')

  const S = SCENARIO_S18
  const clinic = await prisma.clinic.findFirst({ where: { name: S.clinicName } })
  if (!clinic) { console.error(`❌ 找不到診所「${S.clinicName}」`); return }

  let user = await prisma.user.findFirst({ where: { phone: 'TEST_S20' } })
  if (!user) user = await prisma.user.create({
    data: { name: 'S20測試員工', phone: 'TEST_S20', password: 'x', role: 'EMPLOYEE' } })
  let emp = await prisma.employee.findFirst({ where: { userId: user.id } })
  if (!emp) emp = await prisma.employee.create({ data: { userId: user.id, joinDate: new Date('2025-01-01') } })
  await prisma.employeeClinic.upsert({
    where: { employeeId_clinicId: { employeeId: emp.id, clinicId: clinic.id } },
    update: {}, create: { employeeId: emp.id, clinicId: clinic.id } }).catch(() => {})

  // Clean old data
  const monthStart = new Date('2026-07-01T00:00:00+08:00')
  const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
  await prisma.punchVoid.deleteMany({ where: { punchRecord: { employeeId: emp.id } } }).catch(() => {})
  await prisma.punchRecord.deleteMany({ where: { employeeId: emp.id } })
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})
  await prisma.shift.deleteMany({ where: { employeeId: emp.id } })
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})
  await prisma.timeBank.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})

  // 初始化 −2 日（−1080 分鐘）
  await prisma.timeBankEntry.create({ data: {
    employeeId: emp.id, date: new Date('2026-07-01T00:00:00+08:00'),
    type: 'INIT_ADJUST', minutes: -1080,
    note: '測試初始化負帳', createdBy: 'test',
  }})

  // Create shift + punch (OT 10 分鐘)
  await prisma.shift.create({ data: {
    employeeId: emp.id, clinicId: clinic.id,
    date: dt('2026-07-06', '00:00'),
    startTime: dt('2026-07-06', '09:00'), endTime: dt('2026-07-06', '18:00'),
    status: 'CONFIRMED', createdBy: user.id } })
  await prisma.punchRecord.create({ data: {
    employeeId: emp.id, clinicId: clinic.id, punchTime: dt('2026-07-06', '09:00'),
    punchType: 'CLOCK_IN', source: 'QR_DYNAMIC', tokenValid: true } })
  await prisma.punchRecord.create({ data: {
    employeeId: emp.id, clinicId: clinic.id, punchTime: dt('2026-07-06', '18:10'),
    punchType: 'CLOCK_OUT', source: 'QR_DYNAMIC', tokenValid: true } })

  // Run engine
  const config = {
    base_type: 'monthly',
    monthly_salary: S.monthlySalary,
    modifiers: {
      overtime: { mode: 'time_off', hours_per_leave_day: S.rule.otHoursPerLeaveDay },
      working_days: { basis: 'scheduled', rest_days: S.rule.restDays, count_public_holidays: true },
      deduction: { basis: 'statutory' },
    },
  }
  const result = await calculatePayrollWithRules(emp.id, monthStart, clinic.id, config as any)

  // Results
  const tb = (result.detail as any)?.timebank || {}
  console.log(`\n─── S20 結果 ───`)
  console.log(`OT: ${tb.otMinutes ?? '?'} 分 (預期: 10 分)`)
  console.log(`時間帳戶: ${tb.timeAccountMinutes >= 0 ? '+' : ''}${tb.timeAccountMinutes ?? '?'} 分 (預期: -1070 = -1080 + 10 OT)`)

  // Verify
  const otOk = tb.otMinutes === 10
  const accountOk = tb.timeAccountMinutes === -1070
  console.log(`${otOk && accountOk ? '✅ S20 PASS' : '❌ S20 FAIL'}`)
}

// ─── S21: 假還鐘 ───
async function runS21() {
  console.log('\n═══ S21: 假還鐘 ═══\n')

  const S = SCENARIO_S18
  const clinic = await prisma.clinic.findFirst({ where: { name: S.clinicName } })
  if (!clinic) { console.error(`❌ 找不到診所「${S.clinicName}」`); return }

  let user = await prisma.user.findFirst({ where: { phone: 'TEST_S21' } })
  if (!user) user = await prisma.user.create({
    data: { name: 'S21測試員工', phone: 'TEST_S21', password: 'x', role: 'EMPLOYEE' } })
  let emp = await prisma.employee.findFirst({ where: { userId: user.id } })
  if (!emp) emp = await prisma.employee.create({ data: { userId: user.id, joinDate: new Date('2025-01-01') } })
  await prisma.employeeClinic.upsert({
    where: { employeeId_clinicId: { employeeId: emp.id, clinicId: clinic.id } },
    update: {}, create: { employeeId: emp.id, clinicId: clinic.id } }).catch(() => {})

  // Clean old data
  const monthStart = new Date('2026-07-01T00:00:00+08:00')
  const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
  await prisma.punchVoid.deleteMany({ where: { punchRecord: { employeeId: emp.id } } }).catch(() => {})
  await prisma.punchRecord.deleteMany({ where: { employeeId: emp.id } })
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})
  await prisma.shift.deleteMany({ where: { employeeId: emp.id } })
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})
  await prisma.timeBank.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})
  await prisma.leaveBalance.deleteMany({ where: { employeeId: emp.id, year: 2026 } }).catch(() => {})

  // 初始化 −2 日（−1080 分鐘）
  await prisma.timeBankEntry.create({ data: {
    employeeId: emp.id, date: new Date('2026-07-01T00:00:00+08:00'),
    type: 'INIT_ADJUST', minutes: -1080,
    note: '測試初始化負帳', createdBy: 'test',
  }})

  // 休息日餘額 1 天
  const restType = await prisma.leaveType.findFirst({ where: { systemKey: 'REST_DAY' } })
  if (!restType) { console.error('❌ 找不到 REST_DAY 類型'); return }
  await prisma.leaveBalance.create({ data: {
    employeeId: emp.id, leaveTypeId: restType.id, year: 2026,
    entitled: 1, used: 0, remaining: 1,
  } as any})

  // 假還鐘 1 天：扣休息日 + 帳戶進 540 分鐘
  await prisma.leaveBalance.update({
    where: { employeeId_leaveTypeId_year: { employeeId: emp.id, leaveTypeId: restType.id, year: 2026 } },
    data: { used: 1, remaining: 0 },
  })
  await prisma.timeBankEntry.create({ data: {
    employeeId: emp.id, date: new Date(),
    type: 'REST_TO_ACCOUNT', minutes: 540,
    note: '假還鐘 1 天', createdBy: 'test',
  }})

  // Create a normal shift (no OT)
  await prisma.shift.create({ data: {
    employeeId: emp.id, clinicId: clinic.id,
    date: dt('2026-07-06', '00:00'),
    startTime: dt('2026-07-06', '09:00'), endTime: dt('2026-07-06', '18:00'),
    status: 'CONFIRMED', createdBy: user.id } })
  await prisma.punchRecord.create({ data: {
    employeeId: emp.id, clinicId: clinic.id, punchTime: dt('2026-07-06', '09:00'),
    punchType: 'CLOCK_IN', source: 'QR_DYNAMIC', tokenValid: true } })
  await prisma.punchRecord.create({ data: {
    employeeId: emp.id, clinicId: clinic.id, punchTime: dt('2026-07-06', '18:00'),
    punchType: 'CLOCK_OUT', source: 'QR_DYNAMIC', tokenValid: true } })

  // Run engine
  const config = {
    base_type: 'monthly',
    monthly_salary: S.monthlySalary,
    modifiers: {
      overtime: { mode: 'time_off', hours_per_leave_day: S.rule.otHoursPerLeaveDay },
      working_days: { basis: 'scheduled', rest_days: S.rule.restDays, count_public_holidays: true },
      deduction: { basis: 'statutory' },
    },
  }
  const result = await calculatePayrollWithRules(emp.id, monthStart, clinic.id, config as any)

  // Results
  const tb = (result.detail as any)?.timebank || {}
  console.log(`\n─── S21 結果 ───`)
  console.log(`OT: ${tb.otMinutes ?? '?'} 分 (預期: 0 分)`)
  console.log(`時間帳戶: ${tb.timeAccountMinutes >= 0 ? '+' : ''}${tb.timeAccountMinutes ?? '?'} 分 (預期: -540 = -1080 + 540 假還鐘)`)

  // Verify
  const otOk = tb.otMinutes === 0
  const accountOk = tb.timeAccountMinutes === -540
  console.log(`${otOk && accountOk ? '✅ S21 PASS' : '❌ S21 FAIL'}`)
}

runAll().catch(e => { console.error(e); prisma.$disconnect() })
