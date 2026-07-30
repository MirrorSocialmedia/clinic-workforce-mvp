import { PrismaClient } from '@prisma/client'

/**
 * Backfill eoWage for existing FINALIZED/EXPORTED PayrollItems that have eoWage === 0.
 *
 * EO wage = grossPay − storeBonus
 *   (grossPay 已包括 basePay − deduction + otPay + splitPay + attendanceBonus
 *    + storeBonus + allowances − sickDeduction + adwAdjustment + maternity/paternity)
 *   storeBonus 係老闆酌情花紅 → EO 第 2 條唔當工資，剔出
 *
 * Usage:
 *   npx tsx scripts/backfill-eo-wage.ts
 */
const prisma = new PrismaClient()

function deriveEoWage(item: any): number {
  // Use derived formula: eoWage = grossPay − storeBonus
  // grossPay is stored in detailJson; fall back to computing from components if missing.
  try {
    const detail = item.detailJson ? JSON.parse(item.detailJson) : {}
    const grossPay = detail.grossPay ?? null
    if (grossPay != null) {
      return grossPay - (item.storeBonus ?? 0)
    }
  } catch {
    // ignore
  }

  // Fallback: compute grossPay from individual components then subtract storeBonus
  // grossPay = basePay - deduction + otPay + splitPay + attendanceBonus + storeBonus + allowances - sickDeduction + adwAdjustment + maternity + paternity
  // eoWage   = grossPay - storeBonus
  //          = basePay - deduction + otPay + splitPay + attendanceBonus + allowances - sickDeduction + adwAdjustment + maternity + paternity

  try {
    const detail = item.detailJson ? JSON.parse(item.detailJson) : {}
    const allowances = (detail.totalAllowances ?? detail.allowances ?? 0) as number
    const adwAdjustment = (detail.adwAdjustment ?? 0) as number
    const maternityPay = (detail.maternityPay ?? 0) as number
    const paternityPay = (detail.paternityPay ?? 0) as number
    const sickDeduction = (detail.sickDeduction ?? 0) as number
    const attendanceBonus = (detail.attendanceBonus ?? detail.salary?.attendanceBonus ?? 0) as number

    return (
      (item.basePay ?? 0) -
      (item.deduction ?? 0) +
      (item.otPay ?? 0) +
      (item.splitPay ?? 0) +
      attendanceBonus +
      allowances -
      sickDeduction +
      adwAdjustment +
      maternityPay +
      paternityPay
    )
  } catch {
    // Last resort: use stored grossPay and subtract storeBonus
    return (item.basePay ?? 0) + (item.otPay ?? 0) + (item.splitPay ?? 0) + (item.attendanceBonus ?? 0) - (item.deduction ?? 0)
  }
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
