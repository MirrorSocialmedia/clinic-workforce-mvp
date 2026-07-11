/**
 * ═══════════════════════════════════════════════════════════
 *  計糧測試工具 test-payroll.ts
 *  用法：只改下方 SCENARIO 參數，然後跑：
 *    DATABASE_URL="postgresql://clinic:devpass@localhost:5432/clinic_test" npx tsx test-payroll.ts
 *
 *  它會：1) 建測試員工+規則  2) 依你設定的排班/打卡寫入DB
 *        3) 跑計糧引擎  4) 印出每項結果 + 驗算
 *
 *  ⚠️ 用 clinic_test 資料庫，不要對正式庫 clinic_mvp 跑！
 * ═══════════════════════════════════════════════════════════
 */
import { PrismaClient } from '@prisma/client'
import { calculatePayrollWithRules } from './src/lib/payroll-engine'

const prisma = new PrismaClient()

// ╔═══════════════════════════════════════════════════════════╗
// ║  ★★★ 你只需要改這個 SCENARIO 區塊 ★★★                      ║
// ╚═══════════════════════════════════════════════════════════╝
const SCENARIO = {
  // ── 基本 ──
  month: '2026-07',              // 測試月份
  monthlySalary: 15000,          // 月薪
  clinicName: '銅鑼灣診所',        // 用哪家診所（要存在）

  // ── 薪酬規則 ──
  rule: {
    attendanceBonus: 500,        // 勤工獎金額
    cancelBonusIfLateOver: 30,   // 遲到累計超過幾分鐘取消勤工
    cancelBonusIfAbsent: true,   // 缺勤是否取消勤工
    otMode: 'time_off',          // OT 模式：'time_off'(換假) 或 'pay'(補錢)
    otHoursPerLeaveDay: 8,       // OT 累計幾小時換1天假
    restDays: [],
    mpfEnabled: true,            // 是否扣 MPF
    mpfRate: 0.05,               // MPF 比率
  },

  // ── 排班 + 打卡（每一天一筆）──
  // shift: 該天排的班 [開始, 結束]（24小時制）
  // punchIn / punchOut: 實際打卡時間；null = 沒打卡
  // 想測遲到 → punchIn 晚於 shift 開始
  // 想測 OT → punchOut 晚於 shift 結束
  // 想測缺勤 → punchIn/punchOut 都 null（但有排班）
  days: [
    // 日期      排班          上班打卡    下班打卡     說明
    { date: '2026-07-01', shift: ['09:00','18:00'], in: '09:00', out: '18:00' }, // 正常8h
    { date: '2026-07-02', shift: ['09:00','18:00'], in: '09:20', out: '18:00' }, // 遲到20分
    { date: '2026-07-03', shift: ['09:00','18:00'], in: '09:00', out: '20:00' }, // OT 2h
    { date: '2026-07-04', shift: ['09:00','18:00'], in: '09:15', out: '19:30' }, // 遲15分+OT1.5h
    { date: '2026-07-06', shift: ['09:00','18:00'], in: null,    out: null    }, // 缺勤(排了沒打)
    { date: '2026-07-07', shift: ['09:00','18:00'], in: '09:00', out: '22:00' }, // OT 4h
    { date: '2026-07-08', shift: ['09:00','18:00'], in: '09:00', out: '20:30' }, // OT 2.5h
    // 累計 OT: 2+1.5+4+2.5 = 10h → 換 1 天假(滿8h) + 餘2h
    // 累計遲到: 20+15 = 35分 → 超過30 → 勤工取消
  ],
}
// ╔═══════════════════════════════════════════════════════════╗
// ║  ★★★ 改到這裡為止 ★★★                                      ║
// ╚═══════════════════════════════════════════════════════════╝

function dt(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+08:00`)  // 香港時區
}

async function main() {
  console.log('\n═══ 計糧測試開始 ═══\n')

  // 1. 找診所
  const clinic = await prisma.clinic.findFirst({ where: { name: SCENARIO.clinicName } })
  if (!clinic) { console.error(`❌ 找不到診所「${SCENARIO.clinicName}」，請先 seed`); return }

  // 2. 建/取測試員工
  let user = await prisma.user.findFirst({ where: { phone: 'TEST0001' } })
  if (!user) {
    user = await prisma.user.create({
      data: { name: '測試員工', phone: 'TEST0001', password: 'x', role: 'EMPLOYEE' },
    })
  }
  let emp = await prisma.employee.findFirst({ where: { userId: user.id } })
  if (!emp) {
    emp = await prisma.employee.create({ data: { userId: user.id, joinDate: new Date('2025-01-01') } })
  }
  // 綁診所
  await prisma.employeeClinic.upsert({
    where: { employeeId_clinicId: { employeeId: emp.id, clinicId: clinic.id } },
    update: {}, create: { employeeId: emp.id, clinicId: clinic.id },
  }).catch(() => {})

  // 3. 清該員工舊測試資料（該月）
  const monthStart = new Date(`${SCENARIO.month}-01T00:00:00+08:00`)
  const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
  await prisma.punchRecord.deleteMany({ where: { employeeId: emp.id, punchTime: { gte: monthStart, lt: monthEnd } } })
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})
  await prisma.shift.deleteMany({ where: { employeeId: emp.id, date: { gte: monthStart, lt: monthEnd } } })

  // 4. 寫入排班 + 打卡
  for (const d of SCENARIO.days) {
    // 排班
    await prisma.shift.create({
      data: {
        employeeId: emp.id, clinicId: clinic.id,
        date: dt(d.date, '00:00'),
        startTime: dt(d.date, d.shift[0]),
        endTime: dt(d.date, d.shift[1]),
        status: 'CONFIRMED', createdBy: user.id,
      },
    })
    // 打卡
    if (d.in) await prisma.punchRecord.create({
      data: { employeeId: emp.id, clinicId: clinic.id, punchTime: dt(d.date, d.in),
              punchType: 'CLOCK_IN', source: 'QR_DYNAMIC', tokenValid: true },
    })
    if (d.out) await prisma.punchRecord.create({
      data: { employeeId: emp.id, clinicId: clinic.id, punchTime: dt(d.date, d.out),
              punchType: 'CLOCK_OUT', source: 'QR_DYNAMIC', tokenValid: true },
    })
  }

  // 5. 建薪酬規則（新格式，mpf 在 modifiers 裡）
  const config = {
    base_type: 'monthly',
    monthly_salary: SCENARIO.monthlySalary,
    modifiers: {
      attendance_bonus: {
        amount: SCENARIO.rule.attendanceBonus,
        cancel_if: {
          late_minutes_exceed: SCENARIO.rule.cancelBonusIfLateOver,
          late_is_cumulative: true,
          any_unplanned_leave: true,
          any_absence: SCENARIO.rule.cancelBonusIfAbsent,
        },
      },
      overtime: { mode: SCENARIO.rule.otMode, hours_per_leave_day: SCENARIO.rule.otHoursPerLeaveDay },
      working_days: { basis: 'scheduled', rest_days: SCENARIO.rule.restDays, count_public_holidays: true },
      deduction: { basis: 'statutory' },
      mpf: { enabled: SCENARIO.rule.mpfEnabled, rate: SCENARIO.rule.mpfRate, min: 7100, max: 30000 },
    },
  }

  // 6. 跑引擎
  const result = await calculatePayrollWithRules(emp.id, monthStart, clinic.id, config as any)

  // 7. 印結果
  console.log('─── 輸入 ───')
  console.log(`月薪: $${SCENARIO.monthlySalary} | 排班 ${SCENARIO.days.length} 天`)
  console.log('\n─── 計糧結果 ───')
  console.log(`底薪 basePay:          $${result.basePay?.toFixed(2)}`)
  console.log(`缺勤天數 absentDays:    ${result.absentDays}`)
  console.log(`缺勤扣款 deduction:     -$${result.deduction?.toFixed(2)}`)
  console.log(`勤工獎 attendanceBonus: $${result.attendanceBonus?.toFixed(2)} ${result.attendanceBonusCancelled ? `(取消: ${result.attendanceBonusReason})` : ''}`)
  console.log(`加班時數 otHours:       ${result.otHours}h`)
  console.log(`加班費 otPay:          $${result.otPay?.toFixed(2)}`)
  console.log(`實際工時 workedHours:   ${result.workedHours}h`)
  console.log(`換假 leaveDays:        ${result.leaveDays} 天`)
  console.log(`\n應付總額 totalPayable:  $${result.totalPayable?.toFixed(2)}`)
  console.log('\n─── detail（完整明細）───')
  console.log(JSON.stringify(result.detail, null, 2))

  // 8. 自動驗算提示
  console.log('\n─── 驗算檢查 ───')
  const totalOt = SCENARIO.days.reduce((s, d) => {
    if (!d.in || !d.out) return s
    const shiftEnd = dt(d.date, d.shift[1]).getTime()
    const actualOut = dt(d.date, d.out).getTime()
    return s + Math.max(0, (actualOut - shiftEnd) / 3600000)
  }, 0)
  console.log(`預期總OT: ${totalOt}h → 換假應為 ${Math.floor(totalOt / SCENARIO.rule.otHoursPerLeaveDay)} 天`)
  const totalLate = SCENARIO.days.reduce((s, d) => {
    if (!d.in) return s
    const shiftStart = dt(d.date, d.shift[0]).getTime()
    const actualIn = dt(d.date, d.in).getTime()
    return s + Math.max(0, (actualIn - shiftStart) / 60000)
  }, 0)
  console.log(`預期累計遲到: ${totalLate}分 → 勤工${totalLate > SCENARIO.rule.cancelBonusIfLateOver ? '應取消' : '應保留'}`)

  await prisma.$disconnect()
  console.log('\n═══ 測試完成 ═══\n')
}

main().catch(e => { console.error(e); prisma.$disconnect() })
