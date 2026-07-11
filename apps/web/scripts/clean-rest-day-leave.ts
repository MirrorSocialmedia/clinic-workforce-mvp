/**
 * Clean up "休息日" leave balances that were incorrectly created by the old
 * leave-banking logic. Weekends are fixed rest_days, not accrual-able leave.
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/clean-rest-day-leave.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🧹 Cleaning up "休息日" leave data...')

  // 1. Find the "休息日" leave type
  const restDayType = await prisma.leaveType.findFirst({
    where: { name: '休息日' },
  })

  if (!restDayType) {
    console.log('  ✅ No "休息日" LeaveType found. Nothing to clean.')
    await prisma.$disconnect()
    process.exit(0)
  }

  console.log(`  Found LeaveType "休息日" (id: ${restDayType.id})`)

  // 2. Delete all LeaveBalance records for this type
  const balances = await prisma.leaveBalance.findMany({
    where: { leaveTypeId: restDayType.id },
  })

  if (balances.length > 0) {
    await prisma.leaveBalance.deleteMany({
      where: { leaveTypeId: restDayType.id },
    })
    console.log(`  ✅ Deleted ${balances.length} LeaveBalance record(s) for "休息日"`)
  } else {
    console.log('  ✅ No LeaveBalance records for "休息日"')
  }

  // 3. Delete any LeaveRequest records associated with "休息日" type
  const leaves = await prisma.leaveRequest.findMany({
    where: { leaveTypeId: restDayType.id },
  })

  if (leaves.length > 0) {
    await prisma.leaveRequest.deleteMany({
      where: { leaveTypeId: restDayType.id },
    })
    console.log(`  ✅ Deleted ${leaves.length} LeaveRequest record(s) for "休息日"`)
  }

  // 4. Delete the "休息日" LeaveType itself
  await prisma.leaveType.delete({
    where: { id: restDayType.id },
  })
  console.log(`  ✅ Deleted LeaveType "休息日"`)

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
