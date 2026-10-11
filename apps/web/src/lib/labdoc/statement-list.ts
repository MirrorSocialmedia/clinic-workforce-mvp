/**
 * ★ 2026-10-11：月結單列表 — 診所／醫生／總數／確認進度由「分段」計（純函數）。
 *
 * 一份月結單可以有幾位醫生（每個「診所＋醫生」一段）；用家喺分段揀診所／醫生。
 * 之前列表讀單頭（clinicId／providerId／total）— 月結單單頭通常冇，或者係 AI 撞啱讀咗其中一段 → 誤導。
 *
 * 總數：每段優先用對數結果（resultJson.statementTotal，mode=COST，已扣備貨／唔關我哋事）；
 *   未對數嘅段 → 行加埋（INVOICE／CREDIT／CHARGE，唔計備貨／唔關我哋事；舊欠唔計）。
 */
import { EXCLUDE_RESOLUTIONS } from './statement-cost-match'

const COUNTED = new Set(['INVOICE', 'CREDIT', 'CHARGE'])

export interface ListSectionIn {
  clinicId: string | null
  providerId: string | null
  status: string
  resultJson: unknown
  lines?: Array<{ lineType: string; amount: unknown; resolution: string | null; agingBucket: string | null }>
}

export interface StatementListSummary {
  clinicIds: string[]
  providerIds: string[]
  sectionCount: number
  confirmedCount: number
  /** 未揀診所或者醫生嘅段數 */
  unassignedCount: number
  total: number | null
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function statementListSummary(sections: ListSectionIn[]): StatementListSummary {
  const clinicIds: string[] = []
  const providerIds: string[] = []
  let confirmedCount = 0
  let unassignedCount = 0
  let total = 0
  let any = false
  for (const s of sections) {
    if (s.clinicId && !clinicIds.includes(s.clinicId)) clinicIds.push(s.clinicId)
    if (s.providerId && !providerIds.includes(s.providerId)) providerIds.push(s.providerId)
    if (!s.clinicId || !s.providerId) unassignedCount++
    if (s.status === 'CONFIRMED') confirmedCount++
    const rj = (s.resultJson ?? {}) as { mode?: string; statementTotal?: unknown }
    if (rj.mode === 'COST' && typeof rj.statementTotal === 'number') {
      total += rj.statementTotal
      any = true
      continue
    }
    const lines = s.lines ?? []
    const anyBucket = lines.some((l) => l.agingBucket != null)
    for (const l of lines) {
      if (!COUNTED.has(l.lineType)) continue
      if (l.resolution && EXCLUDE_RESOLUTIONS.has(l.resolution)) continue
      if (anyBucket && l.agingBucket !== 'CURRENT') continue
      total += Number(l.amount)
      any = true
    }
  }
  return {
    clinicIds,
    providerIds,
    sectionCount: sections.length,
    confirmedCount,
    unassignedCount,
    total: any ? r2(total) : null,
  }
}
