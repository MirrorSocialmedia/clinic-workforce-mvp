/**
 * 有薪病假累積額度計算（EO 第五章）
 *
 * - 首 12 個月：每服務滿 1 個月累積 2 天
 * - 其後：每服務滿 1 個月累積 4 天
 * - 上限 120 天，可在整個受僱期間持續累積
 *
 * 這是**累積額度**（accumulated entitlement）；實際餘額 = 累積 − 已使用。
 */

/**
 * Calculate accumulated sick leave entitlement.
 *
 * Per HK Employment Ordinance Chapter 5:
 * - First 12 months of service: 2 days per completed month
 * - Thereafter: 4 days per completed month
 * - Maximum 120 days (capped, accumulates throughout employment)
 *
 * @param joinDate Employee's joining date
 * @param asOf    Date to calculate entitlement up to (typically payroll month start or today)
 * @returns Total accumulated sick leave days (capped at 120)
 */
export function calculateSickLeaveQuota(joinDate: Date, asOf: Date): number {
  const monthsServed = monthsDiff(joinDate, asOf)
  if (monthsServed <= 0) return 0

  const firstYear = Math.min(monthsServed, 12)
  const later = Math.max(0, monthsServed - 12)

  return Math.min(firstYear * 2 + later * 4, 120)
}

/**
 * Calculate completed months between two dates.
 * A month counts only if the day of month is reached or exceeded.
 *
 * e.g., 2024-01-15 → 2024-03-14 = 1 month (not 2, since 14 < 15)
 *      2024-01-15 → 2024-03-15 = 2 months
 */
function monthsDiff(from: Date, to: Date): number {
  let m = (to.getFullYear() - from.getFullYear()) * 12
    + (to.getMonth() - from.getMonth())
  if (to.getDate() < from.getDate()) m -= 1
  return m
}
