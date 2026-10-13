/**
 * ★ 2026-10-13：成本錄入逐筆「月結單核對」標示（用家拍板：1 要確認先算　2 確認咗冇配到要提示　3 確認後改價要提示）
 *
 * 只讀：用月結單分段「確認」嗰陣寫低嘅對數結果（resultJson：pairs ＝ 邊幾行配咗邊筆成本、costs ＝ 成本快照），
 * 唔會寫任何嘢。
 *
 *   OK      呢筆喺一段已確認月結單入面配對到，而且而家嘅 Lab／診所／醫生／到貨月／價錢同確認時一樣 → 綠底＋「月」
 *   CHANGED 配對到，但確認之後改咗價（或者搬咗去第二個範圍）→ 唔綠，黃色「核對後改咗價」
 *   MISSING 呢筆嘅範圍（Lab＋診所＋醫生＋到貨月）有已確認嘅月結單分段，但冇一行配到呢筆 → 唔綠，黃色「月結冇呢筆」
 *   （冇已確認分段 → 冇標示）
 *
 * 優先：OK ＞ CHANGED ＞ MISSING（同一筆喺幾段都有紀錄時）。
 * 範圍同 reconcileSection 一致：同 Lab＋診所＋醫生＋periodMonth、成本唔係 VOID。
 * 月結單文件作廢／被取代／重複 → 唔計；分段未確認 → 唔計；舊格式（冇 pairs）→ 唔計（唔會亂出「月結冇呢筆」）。
 */

const INACTIVE_DOC = ['VOID', 'SUPERSEDED', 'DUPLICATE']
const EPS = 0.005

export type CostStatementLinkState = 'OK' | 'CHANGED' | 'MISSING'

export interface CostStatementLink {
  state: CostStatementLinkState
  docId: string
  sectionId: string
  /** CHANGED：確認時嘅價（範圍變咗就係 null） */
  confirmedFinalCost: number | null
}

export interface LinkCostIn {
  id: string
  labId: string | null
  clinicId: string | null
  providerId: string | null
  periodMonth: string | null
  finalCost: number | null
  status: string
}

export interface LinkSectionIn {
  id: string
  documentId: string
  clinicId: string | null
  providerId: string | null
  labId: string | null
  statementMonth: string | null
  resultJson: unknown
}

const scopeKey = (labId: string | null, clinicId: string | null, providerId: string | null, month: string | null) =>
  labId && clinicId && providerId && month ? `${labId}|${clinicId}|${providerId}|${month}` : null

/** 純函數：由已確認分段計每筆成本嘅標示。sections 必須已經係「已確認＋有效文件」。 */
export function linksFromSections(costs: LinkCostIn[], sections: LinkSectionIn[]): Map<string, CostStatementLink> {
  // 每筆成本：配對到嘅紀錄（段、確認時價、段範圍）
  const pairedIn = new Map<string, Array<{ sec: LinkSectionIn; snapCost: number | null; key: string | null }>>()
  // 範圍 → 第一段（「月結冇呢筆」撳去邊段）
  const scopeSec = new Map<string, LinkSectionIn>()
  for (const sec of sections) {
    const rj = (sec.resultJson ?? null) as any
    if (!rj || rj.mode !== 'COST' || !Array.isArray(rj.pairs)) continue
    const key = scopeKey(sec.labId, sec.clinicId, sec.providerId, sec.statementMonth)
    if (key && !scopeSec.has(key)) scopeSec.set(key, sec)
    const snap = new Map<string, number | null>()
    if (Array.isArray(rj.costs)) {
      for (const c of rj.costs) {
        if (c && typeof c.id === 'string') snap.set(c.id, typeof c.finalCost === 'number' ? c.finalCost : c.finalCost == null ? null : Number(c.finalCost))
      }
    }
    for (const p of rj.pairs) {
      if (!p || typeof p.costCaseId !== 'string') continue
      const arr = pairedIn.get(p.costCaseId) ?? []
      arr.push({ sec, snapCost: snap.has(p.costCaseId) ? snap.get(p.costCaseId)! : null, key })
      pairedIn.set(p.costCaseId, arr)
    }
  }

  const out = new Map<string, CostStatementLink>()
  for (const c of costs) {
    if (c.status === 'VOID') continue
    const key = scopeKey(c.labId, c.clinicId, c.providerId, c.periodMonth)
    const hits = pairedIn.get(c.id) ?? []
    const ok = hits.find((h) => h.key !== null && h.key === key && h.snapCost !== null && c.finalCost !== null && Math.abs(h.snapCost - c.finalCost) < EPS)
    if (ok) {
      out.set(c.id, { state: 'OK', docId: ok.sec.documentId, sectionId: ok.sec.id, confirmedFinalCost: ok.snapCost })
      continue
    }
    if (hits.length > 0) {
      const h = hits.find((x) => x.key === key) ?? hits[0]
      out.set(c.id, { state: 'CHANGED', docId: h.sec.documentId, sectionId: h.sec.id, confirmedFinalCost: h.key === key ? h.snapCost : null })
      continue
    }
    const sec = key ? scopeSec.get(key) : undefined
    if (sec) out.set(c.id, { state: 'MISSING', docId: sec.documentId, sectionId: sec.id, confirmedFinalCost: null })
  }
  return out
}

/** 撈相關嘅已確認分段（有效文件），計標示。只讀。 */
export async function costStatementLinks(client: any, costs: LinkCostIn[]): Promise<Map<string, CostStatementLink>> {
  const live = costs.filter((c) => c.status !== 'VOID')
  if (live.length === 0) return new Map()
  // 按呢頁成本嘅 Lab／診所／月搵段（各自 in，寬鬆），linksFromSections 再逐筆精確判斷範圍。
  // 限制：成本確認後搬去另一個月／Lab，而舊範圍唔喺呢頁 → 唔會標 CHANGED（Lab 總數旁邊「核對後成本有改」照樣提示）
  const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))]
  const labIds = uniq(live.map((c) => c.labId))
  const months = uniq(live.map((c) => c.periodMonth))
  if (labIds.length === 0 || months.length === 0) return new Map()
  const rows: any[] = await client.labStatementSection.findMany({
    where: {
      status: 'CONFIRMED',
      clinicId: { in: uniq(live.map((c) => c.clinicId)) },
      document: { kind: 'STATEMENT', labId: { in: labIds }, statementMonth: { in: months }, status: { notIn: INACTIVE_DOC } },
    },
    select: { id: true, documentId: true, clinicId: true, providerId: true, resultJson: true, document: { select: { labId: true, statementMonth: true } } },
    orderBy: [{ confirmedAt: 'asc' }, { id: 'asc' }],
  })
  return linksFromSections(costs, rows.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    clinicId: r.clinicId,
    providerId: r.providerId,
    labId: r.document?.labId ?? null,
    statementMonth: r.document?.statementMonth ?? null,
    resultJson: r.resultJson,
  })))
}
