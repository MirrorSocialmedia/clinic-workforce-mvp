/**
 * 香港《雇佣条例》病假额度计算（首年每月 2 日、之后每月 4 日、上限 120 日）。
 *
 * ⚠️ 2026-07 决定：本系统病假采【无限额度】，唔做额度检查 ——
 *    leave-requests/route.ts 对 systemKey='SICK' 直接跳过余额验证，
 *    成本在计粮端由 computeSickDeduction 按连续日数分级结算。
 *
 * ★ 呢个系【优于法定】的做法。法定上限 120 日之后雇主冇义务付 4/5 粮。
 *   保留呢个档案系为咗：
 *   · 将来如果要改成法定额度制，计算逻辑现成
 *   · 需要向员工说明法定水平时可以引用
 *
 *   目前零 caller 系有意的，唔系漏做。
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
