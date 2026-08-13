/**
 * MD-B: Cost Entry utility functions
 */

/**
 * 計算折扣後成本。
 * @param baseCost - 基本成本（null = 未有價）
 * @param discountPct - 折扣百分比（e.g. 8.5 = 8.5%）
 * @returns 折扣後成本，null 表示未有價
 */
export function computeFinalCost(
  baseCost: number | null,
  discountPct: number | null
): number | null {
  if (baseCost == null) return null // ★ 未有價 → 唔入月結
  if (discountPct == null || discountPct === 0) return baseCost
  return Number((baseCost * (100 - discountPct) / 100).toFixed(2))
}
