/**
 * ═══════════════════════════════════════════════════════════
 *  清數據重測腳本 reset-test-data.ts（更新版）
 *  清掉測試員工的所有排班/打卡/計糧/時間銀行/假期，回到乾淨狀態。
 *
 *  用法：
 *    DATABASE_URL="postgresql://clinic:devpass@localhost:5432/clinic_test" npx tsx reset-test-data.ts
 *
 *  ⚠️ 只清「測試員工」(phone=TEST0001) 的資料，不動其他人。
 *
 *  更新重點（這幾輪新增的表都要清，否則殘留污染測試）：
 *   - TimeBankEntry：補鐘/換假/OT記錄（拖欠、換假消耗都靠這個）
 *   - TimeBank：月度結餘（carriedFrom 從這裡累積 → 不清會滾成58h那種）
 *   - LeaveBalance：假期餘額（休息日累加bug、OT補假都在這）
 * ═══════════════════════════════════════════════════════════
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  console.log('🧹 清除測試員工資料（完整版）...\n')

  const user = await prisma.user.findFirst({ where: { phone: 'TEST0001' } })
  if (!user) { console.log('沒有測試員工，無需清理'); return }
  const emp = await prisma.employee.findFirst({ where: { userId: user.id } })
  if (!emp) { console.log('沒有測試員工記錄'); return }

  const empId = emp.id
  const counts: Record<string, number> = {}

  // 1. 計糧項目
  counts.payrollItem = (await prisma.payrollItem.deleteMany({ where: { employeeId: empId } })).count

  // 2. 🔴 時間銀行明細（補鐘/換假/OT記錄）— 舊腳本沒清
  try { counts.timeBankEntry = (await prisma.timeBankEntry.deleteMany({ where: { employeeId: empId } })).count }
  catch { counts.timeBankEntry = 0 }

  // 3. 🔴 時間銀行月度結餘（carriedFrom 來源，不清會累積成58h）
  try { counts.timeBank = (await prisma.timeBank.deleteMany({ where: { employeeId: empId } })).count }
  catch { counts.timeBank = 0 }

  // 4. 🔴 假期餘額（休息日/年假/OT補假，累加bug在這）
  counts.leaveBalance = (await prisma.leaveBalance.deleteMany({ where: { employeeId: empId } })).count

  // 5. 請假記錄（含排班標記的休息日）
  counts.leaveRequest = (await prisma.leaveRequest.deleteMany({ where: { employeeId: empId } })).count

  // 6. 打卡修正
  try { counts.punchCorrection = (await prisma.punchCorrection.deleteMany({ where: { employeeId: empId } })).count }
  catch { counts.punchCorrection = 0 }

  // 7. 打卡記錄（append-only 觸發器，先停用）
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
  counts.punchRecord = (await prisma.punchRecord.deleteMany({ where: { employeeId: empId } })).count
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})

  // 8. 排班
  counts.shift = (await prisma.shift.deleteMany({ where: { employeeId: empId } })).count

  // 9. 換更申請
  try { counts.shiftChangeRequest = (await prisma.shiftChangeRequest.deleteMany({ where: { OR: [{ fromEmployeeId: empId }, { toEmployeeId: empId }] } })).count }
  catch { counts.shiftChangeRequest = 0 }

  // 10. 薪酬規則
  counts.payRule = (await prisma.payRule.deleteMany({ where: { employeeId: empId } })).count

  console.log('✅ 已清除：')
  console.log(`   計糧項目 PayrollItem:       ${counts.payrollItem}`)
  console.log(`   時間銀行明細 TimeBankEntry: ${counts.timeBankEntry}  ← 補鐘/換假/OT`)
  console.log(`   時間銀行結餘 TimeBank:      ${counts.timeBank}  ← carriedFrom 來源`)
  console.log(`   假期餘額 LeaveBalance:      ${counts.leaveBalance}  ← 休息日/年假/OT補假`)
  console.log(`   請假記錄 LeaveRequest:      ${counts.leaveRequest}`)
  console.log(`   打卡修正 PunchCorrection:   ${counts.punchCorrection}`)
  console.log(`   打卡記錄 PunchRecord:       ${counts.punchRecord}`)
  console.log(`   排班 Shift:                ${counts.shift}`)
  console.log(`   換更申請 ShiftChangeRequest: ${counts.shiftChangeRequest}`)
  console.log(`   薪酬規則 PayRule:           ${counts.payRule}`)
  console.log('\n   測試員工結構保留，可直接重跑 test-payroll.ts')
  console.log('   （時間銀行、假期餘額全清 → carriedFrom/拖欠/休息日不殘留累積）\n')

  // 若要連測試員工都刪除，取消下面註解：
  // await prisma.employeeClinic.deleteMany({ where: { employeeId: empId } })
  // await prisma.employee.delete({ where: { id: empId } })
  // await prisma.user.delete({ where: { id: user.id } })

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); prisma.$disconnect() })
