import { PrismaClient } from '@prisma/client'

/**
 * Backfill eoWage for existing FINALIZED/EXPORTED PayrollItems that have eoWage === 0.
 *
 * EO wage = basePay + otPay + splitPay + storeBonus + attendanceBonus − deduction
 *   (excludes misc reimbursement, employer MPF)
 *
 * Usage:
 *   npx tsx scripts/backfill-eo-wage.ts
 */
const prisma = new PrismaClient()

function deriveEoWage(item: any): number {
  // attendanceBonus may be stored in detailJson (top-level or salary.attendanceBonus)
  const attendanceBonus = (() => {
    try {
      const detail = item.detailJson ? JSON.parse(item.detailJson) : {}
      return (detail.attendanceBonus ?? detail.salary?.attendanceBonus ?? 0) as number
    } catch {
      return 0
    }
  })()

  return (
    (item.basePay ?? 0) +
    (item.otPay ?? 0) +
    (item.splitPay ?? 0) +
    (item.storeBonus ?? 0) +
    attendanceBonus -
    (item.deduction ?? 0)
  )
}

async function main() {
  const items = await prisma.payrollItem.findMany({
    where: {
      eoWage: 0,
      run: { status: { in: ['FINALIZED', 'EXPORTED'] } },
    },
    include: { run: true },
  })

  console.log(`Found ${items.length} PayrollItems with eoWage=0 in FINALIZED/EXPORTED runs.`)

  if (items.length === 0) {
    console.log('Nothing to backfill.')
    return
  }

  let updated = 0
  for (const item of items) {
    const eoWage = Math.round(deriveEoWage(item) * 100) / 100
    await prisma.payrollItem.update({
      where: { id: item.id },
      data: { eoWage },
    })
    updated++
  }

  console.log(`Backfill complete: ${updated} items updated.`)
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
