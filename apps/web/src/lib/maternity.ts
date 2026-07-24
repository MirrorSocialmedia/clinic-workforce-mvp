// ============================================================
// Maternity & Paternity Pay Calculation (EO Compliance)
// Phase 4 — ADW Compliance
// ============================================================
//
// Legal basis (Labour Department Employment Ordinance Guide):
//
// Maternity Pay (EO Chapter 6):
//   - 14 weeks at 4/5 ADW
//   - Weeks 11-14 cap: $80,000 total (claimable via government 發還易)
//   - Specified date = first day of maternity leave
//
// Paternity Pay (EO Chapter 7):
//   - 5 days at 4/5 ADW
//   - If consecutive days > 1, ALL use the ADW from the FIRST day
//   - Specified date = first day of paternity leave
//
// Holiday Overlap (EO):
//   - If maternity leave overlaps with public holidays / rest days,
//     those days count as maternity leave only (4/5 maternity pay),
//     NO separate holiday pay required.
// ============================================================

import { calculateADW } from './adw'

const MATERNITY_CAP_WEEK_11_14 = 80000 // Weeks 11-14 four-week total cap

/**
 * Calculate maternity pay for the days falling in a given month.
 *
 * @param db              PrismaClient instance
 * @param employeeId      Employee ID
 * @param maternityStartDate First day of maternity leave (= specified date for ADW)
 * @param daysInThisMonth Array of Date objects — days in this month that fall within maternity leave
 * @returns calculated maternity pay info
 */
export async function calculateMaternityPay(
  db: any,
  employeeId: string,
  maternityStartDate: Date,
  daysInThisMonth: Array<Date>,
): Promise<{
  amount: number
  capped: boolean
  adw: number
  warnings: string[]
  governmentClaimable: number
}> {
  // ADW specified date = first day of maternity leave
  const adwResult = await calculateADW(db, employeeId, maternityStartDate)
  const dailyPay = adwResult.adw * 0.8

  let normalDays = 0   // Weeks 1-10
  let cappedDays = 0   // Weeks 11-14

  for (const d of daysInThisMonth) {
    const weekIndex = Math.floor(
      (d.getTime() - maternityStartDate.getTime()) / (7 * 24 * 3600 * 1000),
    ) + 1

    if (weekIndex >= 11 && weekIndex <= 14) {
      cappedDays++
    } else {
      normalDays++
    }
  }

  // Weeks 11-14: total capped at $80,000 (four-week aggregate)
  const cappedPortionRaw = cappedDays * dailyPay
  const cappedPortion = Math.min(cappedPortionRaw, MATERNITY_CAP_WEEK_11_14)
  const amount = normalDays * dailyPay + cappedPortion
  const capped = cappedPortionRaw > MATERNITY_CAP_WEEK_11_14

  // Government claimable = weeks 11-14 portion paid (up to cap)
  const governmentClaimable = cappedPortion

  return {
    amount: Math.round(amount * 100) / 100,
    capped,
    adw: adwResult.adw,
    warnings: adwResult.warnings,
    governmentClaimable: Math.round(governmentClaimable * 100) / 100,
  }
}

/**
 * Calculate paternity pay.
 *
 * If consecutive days > 1, ALL days use the ADW computed from the FIRST day
 * (per EO Chapter 7).
 *
 * @param db                PrismaClient instance
 * @param employeeId        Employee ID
 * @param firstPaternityDay First day of paternity leave (= specified date for ADW)
 * @param days              Number of paternity days in this month
 * @returns calculated paternity pay info
 */
export async function calculatePaternityPay(
  db: any,
  employeeId: string,
  firstPaternityDay: Date,
  days: number,
): Promise<{
  amount: number
  adw: number
  warnings: string[]
}> {
  const adwResult = await calculateADW(db, employeeId, firstPaternityDay)
  const amount = adwResult.adw * 0.8 * days

  return {
    amount: Math.round(amount * 100) / 100,
    adw: adwResult.adw,
    warnings: adwResult.warnings,
  }
}

/**
 * Filter out public holidays that fall within a maternity leave period.
 *
 * EO rule: if maternity leave overlaps with public holidays / rest days,
 * those days count as maternity leave only (4/5 maternity pay),
 * no separate holiday pay required.
 *
 * @param publicHolidays    Array of public holiday Date objects
 * @param maternityStart    First day of maternity leave
 * @param maternityEnd      Last day of maternity leave
 * @returns public holidays NOT overlapping with maternity leave
 */
export function filterHolidaysExcludingMaternity(
  publicHolidays: Date[],
  maternityStart: Date,
  maternityEnd: Date,
): Date[] {
  return publicHolidays.filter(
    (h) => h.getTime() < maternityStart.getTime() || h.getTime() > maternityEnd.getTime(),
  )
}
