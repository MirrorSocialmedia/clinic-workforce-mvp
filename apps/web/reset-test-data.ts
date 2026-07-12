/**
 * ═══════════════════════════════════════════════════════════
 *  清數據重測腳本 reset-test-data.ts（v3）
 *  清測試員工(phone=TEST0001)的所有業務資料，並確保系統假期類型存在。
 *
 *  用法：
 *    DATABASE_URL="postgresql://clinic:devpass@localhost:5432/clinic_test" npx tsx reset-test-data.ts
 *
 *  v3 更新：
 *   - 新增 PunchVoid（作廢記錄）清理
 *   - 結尾自動補建系統假期類型（休息日/年假/OT補假，upsert 冪等）
 *   - TimeBankEntry 含所有新 type（MAKEUP/LEAVE_CONVERT/RESTDAY_GRANT/OT_CONVERT_GRANT...）
 * ═══════════════════════════════════════════════════════════
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  console.log('🧹 清除測試員工資料（v3）...\n')

  const user = await prisma.user.findFirst({ where: { phone: 'TEST0001' } })
  const emp = user ? await prisma.employee.findFirst({ where: { userId: user.id } }) : null

  if (emp) {
    const empId = emp.id
    const c: Record<string, number> = {}

    c.payrollItem = (await prisma.payrollItem.deleteMany({ where: { employeeId: empId } })).count
    // 🆕 作廢記錄（先於 PunchRecord，外鍵）
    try { c.punchVoid = (await prisma.punchVoid.deleteMany({
      where: { punchRecord: { employeeId: empId } } })).count } catch { c.punchVoid = 0 }
    try { c.timeBankEntry = (await prisma.timeBankEntry.deleteMany({ where: { employeeId: empId } })).count } catch { c.timeBankEntry = 0 }
    try { c.timeBank = (await prisma.timeBank.deleteMany({ where: { employeeId: empId } })).count } catch { c.timeBank = 0 }
    c.leaveBalance = (await prisma.leaveBalance.deleteMany({ where: { employeeId: empId } })).count
    c.leaveRequest = (await prisma.leaveRequest.deleteMany({ where: { employeeId: empId } })).count
    try { c.punchCorrection = (await prisma.punchCorrection.deleteMany({ where: { employeeId: empId } })).count } catch { c.punchCorrection = 0 }

    await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
    c.punchRecord = (await prisma.punchRecord.deleteMany({ where: { employeeId: empId } })).count
    await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})

    c.shift = (await prisma.shift.deleteMany({ where: { employeeId: empId } })).count
    try { c.shiftChangeRequest = (await prisma.shiftChangeRequest.deleteMany({ where: { fromEmployeeId: empId } })).count } catch { c.shiftChangeRequest = 0 }
    c.payRule = (await prisma.payRule.deleteMany({ where: { employeeId: empId } })).count

    console.log('✅ 已清除：')
    console.log(`   計糧 PayrollItem:        ${c.payrollItem}`)
    console.log(`   作廢 PunchVoid:          ${c.punchVoid}  🆕`)
    console.log(`   時間銀行明細 Entry:       ${c.timeBankEntry}（補鐘/換假/發放標記）`)
    console.log(`   時間銀行結餘 TimeBank:    ${c.timeBank}（carriedFrom 鏈）`)
    console.log(`   假期餘額 LeaveBalance:    ${c.leaveBalance}`)
    console.log(`   請假 LeaveRequest:        ${c.leaveRequest}`)
    console.log(`   打卡修正 Correction:      ${c.punchCorrection}`)
    console.log(`   打卡 PunchRecord:         ${c.punchRecord}`)
    console.log(`   排班 Shift:              ${c.shift}`)
    console.log(`   薪酬規則 PayRule:         ${c.payRule}`)
  } else {
    console.log('沒有測試員工，跳過清理')
  }

  // 🆕 確保系統假期類型存在（被誤刪時補回；upsert 冪等）
  console.log('\n🔒 檢查系統假期類型...')
  const SYSTEM_TYPES = [
    { systemKey: 'REST_DAY',     name: '休息日',  isPaid: true, color: '#4a4a4a' },
    { systemKey: 'ANNUAL_LEAVE', name: '年假',    isPaid: true, color: '#27ae60', annualQuota: 12 },
    { systemKey: 'OT_LEAVE',     name: 'OT補假',  isPaid: true, color: '#8e44ad' },
  ]
  for (const t of SYSTEM_TYPES) {
    const existing = await prisma.leaveType.findUnique({ where: { systemKey: t.systemKey } }).catch(() => null)
    if (!existing) {
      await prisma.leaveType.create({ data: t as any })
      console.log(`   ➕ ${t.name} 已補建`)
    } else {
      console.log(`   ✓ ${t.name} 存在`)
    }
  }

  console.log('\n   測試員工結構保留，可直接重跑 test-payroll.ts\n')
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); prisma.$disconnect() })
