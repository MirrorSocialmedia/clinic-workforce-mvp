/**
 * ★ cwm-money P2-6：「某月用邊條薪酬規則」單一來源（engine / preview / resign-settlement 共用）
 * ① 先揀 active 規則（覆蓋本月）—— 在職員工 100% 行呢條，行為同改前一樣（生死格 G1）
 * ② 冇 → 退回「經 POST 停用、有 effectiveTo、仍覆蓋本月」嘅舊規則
 *    effectiveTo 為 null 嘅停用規則（人手清理／作廢）一律唔用
 */
export async function findPayRuleForMonth(db: any, employeeId: string, monthStart: Date, monthEnd: Date) {
  const active = await db.payRule.findFirst({
    where: {
      employeeId, isActive: true,
      effectiveFrom: { lte: monthEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  })
  if (active) return active
  const olds = await db.payRule.findMany({
    where: { employeeId, isActive: false, effectiveFrom: { lte: monthEnd }, effectiveTo: { not: null, gte: monthStart } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    take: 5,
  })
  // effectiveTo < effectiveFrom = 從未生效（被更早生效嘅新規則取代）
  return olds.find((r: any) => r.effectiveTo >= r.effectiveFrom) ?? null
}
