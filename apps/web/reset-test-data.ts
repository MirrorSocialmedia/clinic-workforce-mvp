/**
 * ═══════════════════════════════════════════════════════════
 *  清數據重測腳本 reset-test-data.ts
 *  清掉測試員工的所有排班/打卡/計糧，回到乾淨狀態重測。
 *
 *  用法：
 *    DATABASE_URL="postgresql://clinic:devpass@localhost:5432/clinic_test" npx tsx reset-test-data.ts
 *
 *  ⚠️ 只清「測試員工」(phone=TEST0001) 的資料，不動其他人。
 *     若要全庫重置，用 npx prisma migrate reset --force
 * ═══════════════════════════════════════════════════════════
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  console.log('🧹 清除測試員工資料...\n')

  const user = await prisma.user.findFirst({ where: { phone: 'TEST0001' } })
  if (!user) { console.log('沒有測試員工，無需清理'); return }
  const emp = await prisma.employee.findFirst({ where: { userId: user.id } })
  if (!emp) { console.log('沒有測試員工記錄'); return }

  // 依外鍵順序清（測試員工的所有業務資料）
  await prisma.payrollItem.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})
  await prisma.punchCorrection.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})

  // PunchRecord 有 append-only 觸發器，先停用
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
  const p = await prisma.punchRecord.deleteMany({ where: { employeeId: emp.id } })
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})

  const s = await prisma.shift.deleteMany({ where: { employeeId: emp.id } })
  await prisma.leaveRequest.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})
  await prisma.leaveBalance.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})
  await prisma.timeBank.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})
  await prisma.payRule.deleteMany({ where: { employeeId: emp.id } }).catch(() => {})

  console.log(`✅ 已清除：${p.count} 筆打卡、${s.count} 筆排班、及相關計糧/假期/規則`)
  console.log('   測試員工結構保留，可直接重跑 test-payroll.ts\n')

  // 若要連測試員工都刪除，取消下面註解：
  // await prisma.employeeClinic.deleteMany({ where: { employeeId: emp.id } })
  // await prisma.employee.delete({ where: { id: emp.id } })
  // await prisma.user.delete({ where: { id: user.id } })
  // console.log('   測試員工帳號也已刪除')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); prisma.$disconnect() })
