import { PrismaClient } from '@prisma/client'

/**
 * Backfill eoWage for existing FINALIZED/EXPORTED PayrollItems that have eoWage === 0.
 *
 * EO wage = grossPay − storeBonus
 *   where grossPay is stored in detailJson (computed at payroll generation time).
 *
 * This formula covers:
 *   basePay − deduction + otPay + splitPay + attendanceBonus + storeBonus
 *   + totalAllowances − sickDeduction + adwAdjustment + maternityPay + paternityPay
 *   (all rolled into grossPay; only storeBonus is subtracted back out)
 *
 * Usage:
 *   npx tsx scripts/backfill-eo-wage.ts
 */
const prisma = new PrismaClient()

function deriveEoWage(item: any): number | null {
  const storeBonus = item.storeBonus ?? 0

  // Try to read grossPay from detailJson (stored during payroll generation)
  let grossPay: number | null = null
  try {
    const detail = item.detailJson ? JSON.parse(item.detailJson) : {}
    grossPay = detail.grossPay ?? null
  } catch {
    // detailJson parse failed — skip this item
    return null
  }

  if (grossPay == null) {
    // Fallback: reconstruct from columns (for very old records without grossPay in detailJson)
    // grossPay ≈ basePay − deduction + otPay + splitPay + attendanceBonus + storeBonus
    //   + allowances − sickDeduction + adwAdjustment + maternityPay + paternityPay
    // attendanceBonus may be in detailJson
    let attendanceBonus = 0
    let totalAllowances = 0
    let adwAdjustment = 0
    let sickDeduction = 0
    try {
      const detail = JSON.parse(item.detailJson)
      attendanceBonus = detail.attendanceBonus ?? detail.salary?.attendanceBonus ?? 0
      totalAllowances = detail.totalAllowances ?? 0
      adwAdjustment = detail.adwAdjustment ?? 0
      sickDeduction = detail.sickDeduction ?? 0
    } catch { /* ignore */ }

    grossPay =
      (item.basePay ?? 0) -
      (item.deduction ?? 0) +
      (item.otPay ?? 0) +
      (item.splitPay ?? 0) +
      attendanceBonus +
      storeBonus +
      totalAllowances -
      sickDeduction +
      adwAdjustment +
      (item.maternityPay ?? 0) +
      (item.paternityPay ?? 0)
  }

  return Math.round((grossPay! - storeBonus) * 100) / 100
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
  let skipped = 0
  for (const item of items) {
    const eoWage = deriveEoWage(item)
    if (eoWage == null) {
      console.warn(`  SKIP ${item.id}: grossPay not available in detailJson`)
      skipped++
      continue
    }
    await prisma.payrollItem.update({
      where: { id: item.id },
      data: { eoWage },
    })
    updated++
  }

  console.log(`Backfill complete: ${updated} items updated, ${skipped} skipped.`)
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
