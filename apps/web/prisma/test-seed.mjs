// ════════ CONFIG:只改這一段 ════════
const CONFIG = {
  owner:    { name: '老闆', phone: '56214219' },      // 密碼固定 12345678(見下方 PASSWORD_HASH)
  company:  '測試公司',
  clinic:   { name: '大圍', shortName: '圍' },
  employee: {
    name: 'TestEmp', phone: '12345',               // 密碼同上固定 12345678
    joinDate: '2025-06-01',
  },
  // 考勤參數(薪規):
  pay: {
    payType: 'MONTHLY',            // MONTHLY | HOURLY
    baseAmount: 17500,
    config: { working_days: { rest_days: [6, 0] }, deduction_rate: 1, ot_min_minutes: 0 },
  },
  // 排班表:'日期 上班-下班'
   shifts: [
        '2026-06-03 10:00-20:00',
        '2026-06-04 10:00-20:00',
        '2026-06-05 10:00-20:00',
        '2026-06-06 10:00-20:00',
        '2026-06-07 10:00-20:00',
        '2026-06-08 10:00-20:00',
        '2026-06-10 10:00-20:00',
        '2026-06-11 10:00-20:00',
        '2026-06-13 10:00-20:00',
        '2026-06-14 10:00-20:00',
        '2026-06-15 10:00-20:00',
        '2026-06-17 10:00-20:00',
        '2026-06-18 10:00-20:00',
        '2026-06-19 10:00-20:00',
        '2026-06-21 10:00-20:00',
        '2026-06-22 10:00-20:00',
        '2026-06-25 10:00-20:00',
        '2026-06-26 10:00-20:00',
        '2026-06-27 10:00-20:00',
        '2026-06-28 10:00-20:00',
        '2026-06-29 10:00-20:00',

    ],
    // 打卡記錄:'日期 時間 IN|OUT'
    punches: [
        '2026-06-03 10:00 IN', '2026-07-03 20:00 OUT',
        '2026-06-04 10:00 IN', '2026-07-04 20:00 OUT',
        '2026-06-05 10:00 IN', '2026-07-05 20:00 OUT',
        '2026-06-06 10:00 IN', '2026-07-06 20:00 OUT',
        '2026-06-07 10:00 IN', '2026-07-07 20:00 OUT',
        '2026-06-08 10:00 IN', '2026-07-08 20:00 OUT',
        '2026-06-10 10:00 IN', '2026-07-10 20:00 OUT',
        '2026-06-11 10:00 IN', '2026-07-11 20:00 OUT',
        '2026-06-13 10:00 IN', '2026-07-13 20:00 OUT',
        '2026-06-14 10:00 IN', '2026-07-14 20:00 OUT',
        '2026-06-15 10:00 IN', '2026-07-15 20:00 OUT',
        '2026-06-17 10:00 IN', '2026-07-17 20:00 OUT',
        '2026-06-18 10:00 IN', '2026-07-18 20:00 OUT',
        '2026-06-19 10:00 IN', '2026-07-19 20:00 OUT',
        '2026-06-21 10:00 IN', '2026-07-21 20:00 OUT',
        '2026-06-22 10:00 IN', '2026-07-22 20:00 OUT',
        '2026-06-25 10:00 IN', '2026-07-25 20:00 OUT',

    ],
    punchSource: 'QR_STATIC',               // ← 對照第0節 grep 的枚舉值
  // 休息日配額(年池預發放;key=月份, value=該月配額天數——照「該月休息星期幾次數+公眾假期」自己數,或先隨手給9)
  restDayGrants: { '2026-06': 9, '2026-07': 9 },
}
// ════════ 以下不用動 ════════
import { PrismaClient } from '@prisma/client'
// bcryptjs 被 Next 捆進 route chunk,/app/node_modules 沒有它——雜湊預先算好烘死:
// 對應密碼 12345678(cost 12);要換密碼再找我生成新 hash,或登入後用介面改
const PASSWORD_HASH = '$2a$12$QVrLaZFSTMvH.KhPY0oUauDGAecPET/pdCkCWh8t7wfjnVP8iyRSC'
const prisma = new PrismaClient()
const hk = (d, t = '00:00') => new Date(`${d}T${t}:00+08:00`)   // 鐵律:一律 HK 時區落庫

async function main() {
  const company = await prisma.company.create({ data: { name: CONFIG.company } })
  const clinic = await prisma.clinic.create({ data: {
    name: CONFIG.clinic.name, shortName: CONFIG.clinic.shortName, companyId: company.id } })

  for (const lt of [
    { name: '年假', systemKey: 'ANNUAL_LEAVE', isPaid: true },
    { name: '病假', systemKey: 'SICK', isPaid: true },
    { name: '休息日', systemKey: 'REST_DAY', isPaid: true },
    { name: 'OT補假', systemKey: 'OT_LEAVE', isPaid: true },
    { name: '無薪假', systemKey: null, isPaid: false },
  ]) await prisma.leaveType.create({ data: lt })

  const ownerUser = await prisma.user.create({ data: {
    name: CONFIG.owner.name, phone: CONFIG.owner.phone,
    password: PASSWORD_HASH, role: 'OWNER', status: 'ACTIVE' } })
  await prisma.userClinic.create({ data: { userId: ownerUser.id, clinicId: clinic.id } })

  const empUser = await prisma.user.create({ data: {
    name: CONFIG.employee.name, phone: CONFIG.employee.phone,
    password: PASSWORD_HASH, role: 'EMPLOYEE', status: 'ACTIVE' } })
  await prisma.userClinic.create({ data: { userId: empUser.id, clinicId: clinic.id } })
  const employee = await prisma.employee.create({ data: {
    userId: empUser.id, homeClinicId: clinic.id, joinDate: hk(CONFIG.employee.joinDate) } })
  await prisma.employeeClinic.create({ data: { employeeId: employee.id, clinicId: clinic.id } })

  await prisma.payRule.create({ data: {
    employeeId: employee.id, payType: CONFIG.pay.payType, baseAmount: CONFIG.pay.baseAmount,
    configJson: JSON.stringify(CONFIG.pay.config), effectiveFrom: hk('2025-01-01'),
    createdBy: ownerUser.id } })

  // 休息日:忠實復刻引擎的冪等發放(標記行+年池),之後引擎算糧不會重複發
  const restType = await prisma.leaveType.findUnique({ where: { systemKey: 'REST_DAY' } })
  const byYear = {}
  for (const [ym, days] of Object.entries(CONFIG.restDayGrants || {})) {
    const [y, m] = ym.split('-').map(Number)
    await prisma.timeBankEntry.create({ data: {
      employeeId: employee.id, date: hk(`${ym}-01`), type: 'RESTDAY_GRANT',
      minutes: days * 24 * 60, note: `restday_grant_${y}_${m} 種子預發`,
    } })
    byYear[y] = (byYear[y] || 0) + days
  }
  for (const [y, total] of Object.entries(byYear)) {
    await prisma.leaveBalance.create({ data: {
      employeeId: employee.id, leaveTypeId: restType.id, year: Number(y),
      entitled: total, used: 0, remaining: total,
    } })
  }

  for (const s of CONFIG.shifts) {
    const [d, range] = s.split(' ')
    const [st, en] = range.split('-')
    await prisma.shift.create({ data: {
      employeeId: employee.id, clinicId: clinic.id,
      date: hk(d), startTime: hk(d, st), endTime: hk(d, en), createdBy: ownerUser.id } })
  }
  for (const p of CONFIG.punches) {
    const [d, t, io] = p.split(' ')
    await prisma.punchRecord.create({ data: {
      employeeId: employee.id, clinicId: clinic.id,
      punchTime: hk(d, t), punchType: io === 'IN' ? 'CLOCK_IN' : 'CLOCK_OUT',
      source: CONFIG.punchSource, tokenValid: true } })
  }
  console.log(`✅ 完成:OWNER ${CONFIG.owner.phone} / 員工 ${CONFIG.employee.phone}(密碼 12345678)`)
}
main().finally(() => prisma.$disconnect())
