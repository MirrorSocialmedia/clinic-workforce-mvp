/**
 * ★ 2026-10-11：成本錄入頁底「按 lab」總數 — 標示呢間 Lab 呢個月（到貨日）月結單核對狀態。
 *
 * 範圍跟成本錄入頁 filter：月份（periodMonth，到貨日模式先有）、診所、醫生。
 * 搵同 Lab、同月、有效（唔係 VOID／SUPERSEDED／DUPLICATE）月結單喺呢個範圍嘅分段：
 *   - 有分段未確認                         → IN_PROGRESS（月結對緊）
 *   - 全部確認，但成本錄入有啲醫生月結單冇 → PARTIAL（⚠ 有 $X 唔喺月結單）
 *   - 全部確認，但確認後成本總數改咗       → CHANGED（⚠ 核對後成本有改）
 *   - 全部確認，確認時有差額（寫咗原因）   → OK_DIFF（✓ 月結已核對（差 $X））
 *   - 全部確認，一致                       → OK（✓ 月結已核對）
 *   - 冇月結單                             → 唔出
 */

export type StatementMarkStatus = 'OK' | 'OK_DIFF' | 'CHANGED' | 'PARTIAL' | 'IN_PROGRESS'

export interface StatementMark {
  status: StatementMarkStatus
  docId: string
  /** 確認時差額（月結單 − 成本）合計 */
  diff: number
  /** 確認時寫嘅原因 */
  reasons: string[]
  /** CHANGED：而家成本 − 確認時成本 */
  changedBy: number
  /** PARTIAL：成本錄入有、月結單冇呢位醫生嘅金額 */
  uncoveredTotal: number
}

const r2 = (n: number) => Math.round(n * 100) / 100
const EPS = 0.01

export async function costStatementMarks(
  client: any,
  args: { month: string; labIds: string[]; clinicIds: string[] | null; providerId: string | null },
): Promise<Record<string, StatementMark>> {
  const out: Record<string, StatementMark> = {}
  if (args.labIds.length === 0) return out
  const sections: any[] = await client.labStatementSection.findMany({
    where: {
      document: { kind: 'STATEMENT', labId: { in: args.labIds }, statementMonth: args.month, status: { notIn: ['VOID', 'SUPERSEDED', 'DUPLICATE'] } },
      ...(args.clinicIds ? { clinicId: { in: args.clinicIds } } : {}),
      ...(args.providerId ? { providerId: args.providerId } : {}),
    },
    select: { status: true, clinicId: true, providerId: true, resultJson: true, note: true, document: { select: { id: true, labId: true } } },
  })
  if (sections.length === 0) return out

  // 而家成本（同 Lab、同月、範圍內），按 Lab＋診所＋醫生
  const groups: any[] = await client.costCase.groupBy({
    by: ['labId', 'clinicId', 'providerId'],
    where: {
      labId: { in: args.labIds },
      periodMonth: args.month,
      status: { not: 'VOID' },
      ...(args.clinicIds ? { clinicId: { in: args.clinicIds } } : {}),
      ...(args.providerId ? { providerId: args.providerId } : {}),
    },
    _sum: { finalCost: true },
  })
  const liveCost = new Map<string, number>()
  for (const g of groups) liveCost.set(`${g.labId}|${g.clinicId}|${g.providerId}`, Number(g._sum?.finalCost ?? 0))

  const byLab = new Map<string, any[]>()
  for (const s of sections) {
    const k = s.document.labId as string
    byLab.set(k, [...(byLab.get(k) ?? []), s])
  }
  for (const [labId, secs] of byLab) {
    const docId = secs[0].document.id as string
    const pending = secs.find((s) => s.status !== 'CONFIRMED')
    if (pending) {
      out[labId] = { status: 'IN_PROGRESS', docId: pending.document.id, diff: 0, reasons: [], changedBy: 0, uncoveredTotal: 0 }
      continue
    }
    const covered = new Set(secs.filter((s) => s.clinicId && s.providerId).map((s) => `${labId}|${s.clinicId}|${s.providerId}`))
    let uncoveredTotal = 0
    for (const [k, v] of liveCost) if (k.startsWith(`${labId}|`) && !covered.has(k)) uncoveredTotal += v
    let changedBy = 0
    let diff = 0
    const reasons: string[] = []
    for (const s of secs) {
      const rj = (s.resultJson ?? {}) as any
      if (typeof rj.diff === 'number') diff += rj.diff
      if (s.note) reasons.push(s.note)
      if (s.clinicId && s.providerId && typeof rj.costTotal === 'number') {
        changedBy += (liveCost.get(`${labId}|${s.clinicId}|${s.providerId}`) ?? 0) - rj.costTotal
      }
    }
    diff = r2(diff)
    changedBy = r2(changedBy)
    uncoveredTotal = r2(uncoveredTotal)
    const status: StatementMarkStatus =
      Math.abs(uncoveredTotal) > EPS ? 'PARTIAL' : Math.abs(changedBy) > EPS ? 'CHANGED' : Math.abs(diff) > EPS ? 'OK_DIFF' : 'OK'
    out[labId] = { status, docId, diff, reasons, changedBy, uncoveredTotal }
  }
  return out
}
