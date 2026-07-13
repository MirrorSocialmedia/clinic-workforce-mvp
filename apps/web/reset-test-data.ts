/**
 * ═══════════════════════════════════════════════════════════════
 *  彻底重置腳本 reset-test-data.ts（v4 — 全量版）
 *
 *  清除「所有業務資料 + 所有員工」，回到乾淨基線。
 *  保留：診所、OWNER/MANAGER 帳號、更次模板、系統假期類型（自動補建）。
 *
 *  用法：
 *    DATABASE_URL="postgresql://clinic:devpass@localhost:5432/clinic_test" npx tsx reset-test-data.ts
 *
 *  ⚠️ 這是全量清除（包含你在UI建的所有員工）。只在測試庫跑！
 *  若要保留某些員工，把電話加進下面 KEEP_PHONES。
 * ═══════════════════════════════════════════════════════════════
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

// ★ 想保留的員工電話（不刪）。空 = 全部員工都刪。
const KEEP_PHONES: string[] = []
// 是否連審計日誌一起清（true = 清）
const CLEAR_AUDIT = true

async function del(label: string, fn: () => Promise<{ count: number }>) {
  try { const r = await fn(); console.log(`   ${label.padEnd(28)} ${r.count}`); return r.count }
  catch (e: any) { console.log(`   ${label.padEnd(28)} skip(${e.code ?? 'err'})`); return 0 }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL || ''
  console.log(`\n🧹 全量重置（v4）\n   DB: ${dbUrl.split('/').pop()}\n`)
  if (!dbUrl.includes('test') ) {
    console.log('⚠️  DATABASE_URL 不含 "test"——確認你不是在清正式庫！5秒後繼續（Ctrl+C 取消）...')
    await new Promise(r => setTimeout(r, 5000))
  }

  // 要刪的員工（排除 KEEP_PHONES 和非員工帳號）
  const keepUsers = await prisma.user.findMany({
    where: { OR: [{ role: { in: ['OWNER', 'MANAGER', 'ACCOUNTANT'] as any } }, { phone: { in: KEEP_PHONES } }] },
    select: { id: true, phone: true, role: true },
  })
  const keepUserIds = keepUsers.map(u => u.id)
  const targetEmps = await prisma.employee.findMany({
    where: { userId: { notIn: keepUserIds } }, select: { id: true, userId: true },
  })
  const empIds = targetEmps.map(e => e.id)
  console.log(`保留帳號：${keepUsers.map(u => `${u.phone}(${u.role})`).join(', ') || '無'}`)
  console.log(`將刪除員工：${empIds.length} 名 + 全部業務資料\n`)

  console.log('── 業務資料（全量，含保留員工的舊資料也一併清）──')
  // FK 順序：子先父後
  await del('計糧項目 PayrollItem', () => prisma.payrollItem.deleteMany({}))
  await del('計糧批次 PayrollRun', () => prisma.payrollRun.deleteMany({}))
  await del('作廢記錄 PunchVoid', () => prisma.punchVoid.deleteMany({}))
  await del('時間銀行明細 TimeBankEntry', () => prisma.timeBankEntry.deleteMany({}))
  await del('時間銀行結餘 TimeBank', () => prisma.timeBank.deleteMany({}))
  await del('假期餘額 LeaveBalance', () => prisma.leaveBalance.deleteMany({}))
  await del('請假記錄 LeaveRequest', () => prisma.leaveRequest.deleteMany({}))
  await del('打卡修正 PunchCorrection', () => prisma.punchCorrection.deleteMany({}))

  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER USER').catch(() => {})
  await del('打卡記錄 PunchRecord', () => prisma.punchRecord.deleteMany({}))
  await prisma.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER USER').catch(() => {})

  await del('排班 Shift', () => prisma.shift.deleteMany({}))
  await del('換更申請 ShiftChangeRequest', () => prisma.shiftChangeRequest.deleteMany({}))
  await del('薪酬規則 PayRule', () => prisma.payRule.deleteMany({}))
  if (CLEAR_AUDIT) await del('審計日誌 AuditLog', () => prisma.auditLog.deleteMany({}))

  console.log('\n── 員工帳號（保留名單以外全刪）──')
  await del('員工-診所關聯', () => prisma.employeeClinic.deleteMany({ where: { employeeId: { in: empIds } } }))
  await del('員工 Employee', () => prisma.employee.deleteMany({ where: { id: { in: empIds } } }))
  await del('員工用戶 User', () => prisma.user.deleteMany({
    where: { id: { in: targetEmps.map(e => e.userId) } } }))

  // 非系統假期類型也清（保留 systemKey 三個 + 重建）
  console.log('\n── 假期類型 ──')
  await del('一般假期類型（非系統）', () => prisma.leaveType.deleteMany({ where: { systemKey: null } }))
  for (const t of [
    { systemKey: 'REST_DAY', name: '休息日', isPaid: true, color: '#4a4a4a' },
    { systemKey: 'ANNUAL_LEAVE', name: '年假', isPaid: true, color: '#27ae60', annualQuota: 12 },
    { systemKey: 'OT_LEAVE', name: 'OT補假', isPaid: true, color: '#8e44ad' },
  ]) {
    const ex = await prisma.leaveType.findUnique({ where: { systemKey: t.systemKey } }).catch(() => null)
    if (!ex) { await prisma.leaveType.create({ data: t as any }); console.log(`   ➕ 補建 ${t.name}`) }
    else console.log(`   ✓ ${t.name} 保留`)
  }

  console.log('\n✅ 重置完成。保留：診所、OWNER帳號、更次模板、系統假期類型。')
  console.log('   下一步：UI 建員工/或跑 test-full-suite.ts（自建自清）。\n')
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); prisma.$disconnect(); process.exit(1) })
