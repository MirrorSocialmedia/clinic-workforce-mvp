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
import { calculatePayrollWithRules } from './src/lib/payroll-engine'

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

  await prisma.$disconnect()
  console.log('\n═══ 完成 ═══\n')
}

main().catch(e => { console.error(e); prisma.$disconnect() })
