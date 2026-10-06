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

/**
 * ★ cwm-tbmonthrule-20261006：批量版 findPayRuleForMonth（逐人揀法一模一樣，兩條 query 攞晒）——
 *   確認計糧 transaction 內逐人 findFirst 會 N+1 撞 timeout（2026-08-15 撞過）。
 */
export async function findPayRulesForMonth(
  db: any, employeeIds: string[], monthStart: Date, monthEnd: Date,
): Promise<Map<string, any>> {
  const out = new Map<string, any>()
  if (employeeIds.length === 0) return out
  const actives = await db.payRule.findMany({
    where: {
      employeeId: { in: employeeIds }, isActive: true,
      effectiveFrom: { lte: monthEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  })
  for (const r of actives) if (!out.has(r.employeeId)) out.set(r.employeeId, r)
  const missing = employeeIds.filter(id => !out.has(id))
  if (missing.length > 0) {
    const olds = await db.payRule.findMany({
      where: { employeeId: { in: missing }, isActive: false, effectiveFrom: { lte: monthEnd }, effectiveTo: { not: null, gte: monthStart } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    })
    for (const r of olds) {
      if (out.has(r.employeeId)) continue
      if (r.effectiveTo >= r.effectiveFrom) out.set(r.employeeId, r)
    }
  }
  return out
}

/** 時薪規則（同計糧引擎 calculatePayrollWithRules 同一判斷：configJson.base_type === 'hourly'）；壞 JSON 當非時薪 */
export function isHourlyRule(rule: { configJson?: string | null } | null | undefined): boolean {
  if (!rule?.configJson) return false
  try { return JSON.parse(rule.configJson)?.base_type === 'hourly' } catch { return false }
}

/**
 * ★ cwm-tbmonthrule-20261006：嗰個月要唔要計「編更差額（應返工時）」——
 *   一定要用【嗰個月生效】嘅規則，唔可以用而家最新嗰條：
 *   9 月兼職、10 月轉全職 → 用最新規則會當 9 月係月薪，扣咗成個月「應返」（實例 −4,620 分鐘）。
 */
export function rosterDiffApplies(
  rule: { payType?: string | null; configJson?: string | null } | null | undefined,
  attendanceExempt: boolean | null | undefined,
): boolean {
  return rule?.payType === 'MONTHLY' && !isHourlyRule(rule) && attendanceExempt !== true
}
