/**
 * Clean up stale "休息日" leave data BEFORE migrating to systemKey-based types.
 * 
 * This script:
 * 1. Deletes old non-system "休息日" LeaveType (if systemKey is null)
 * 2. Deletes associated LeaveBalance and LeaveRequest records
 * 3. Deletes stale RESTDAY_GRANT TimeBankEntry records
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/clean-rest-day-leave.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🧹 Cleaning up stale "休息日" leave data...')

  // 1. Find old "休息日" LeaveType without systemKey (pre-migration pollution)
  const oldRestDayTypes = await prisma.leaveType.findMany({
    where: { name: '休息日', systemKey: null },
  })

  if (oldRestDayTypes.length === 0) {
    console.log('  ✅ No stale "休息日" LeaveType found. Nothing to clean.')
    await prisma.$disconnect()
    process.exit(0)
  }

  for (const restDayType of oldRestDayTypes) {
    console.log(`  Found stale LeaveType "休息日" (id: ${restDayType.id})`)

    // 2. Delete all LeaveBalance records for this type
    const balances = await prisma.leaveBalance.deleteMany({
      where: { leaveTypeId: restDayType.id },
    })
    console.log(`  ✅ Deleted ${balances.count} LeaveBalance record(s)`)

    // 3. Delete any LeaveRequest records
    const leaves = await prisma.leaveRequest.deleteMany({
      where: { leaveTypeId: restDayType.id },
    })
    console.log(`  ✅ Deleted ${leaves.count} LeaveRequest record(s)`)

    // 4. Delete the stale LeaveType
    await prisma.leaveType.delete({ where: { id: restDayType.id } })
    console.log(`  ✅ Deleted stale LeaveType "休息日"`)
  }

  // 5. Delete stale RESTDAY_GRANT TimeBankEntry records (pre-migration markers)
  const grants = await prisma.timeBankEntry.deleteMany({
    where: { type: 'RESTDAY_GRANT' },
  })
  console.log(`  ✅ Deleted ${grants.count} stale RESTDAY_GRANT record(s)`)

  console.log('✅ Cleanup complete!')
}

main()
  .catch((err) => {
    console.error('❌ Cleanup failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
