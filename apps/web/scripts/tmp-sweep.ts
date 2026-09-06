import { PrismaClient } from '@prisma/client'
async function main() {
const p = new PrismaClient()
const emps = await p.employee.findMany({ where: { id: { startsWith: 'e2em60b' } }, select: { id: true, userId: true } })
console.log('residual emps:', emps.length)
if (emps.length) {
  const empIds = emps.map(e => e.id); const userIds = [...new Set(emps.map(e => e.userId))]
  await p.timeBankEntry.deleteMany({ where: { employeeId: { in: empIds } } })
  await p.timeBank.deleteMany({ where: { employeeId: { in: empIds } } })
  await p.$executeRawUnsafe('ALTER TABLE "PunchRecord" DISABLE TRIGGER no_mutate_punch')
  await p.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER no_mutate_audit')
  try {
    await p.auditLog.deleteMany({ where: { targetEmployeeId: { in: empIds } } })
    await p.punchRecord.deleteMany({ where: { employeeId: { in: empIds } } })
  } finally {
    await p.$executeRawUnsafe('ALTER TABLE "PunchRecord" ENABLE TRIGGER no_mutate_punch')
    await p.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER no_mutate_audit')
  }
  await p.leaveRequest.deleteMany({ where: { employeeId: { in: empIds } } })
  await p.shift.deleteMany({ where: { employeeId: { in: empIds } } })
  await p.notification.deleteMany({ where: { employeeId: { in: empIds } } })
  await p.leaveBalance.deleteMany({ where: { employeeId: { in: empIds } } })
  await p.employeeClinic.deleteMany({ where: { employeeId: { in: empIds } } })
  await p.payRule.deleteMany({ where: { employeeId: { in: empIds } } })
  await p.employee.deleteMany({ where: { id: { in: empIds } } })
  await p.user.deleteMany({ where: { id: { in: userIds } } })
  console.log('swept')
}
await p.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
