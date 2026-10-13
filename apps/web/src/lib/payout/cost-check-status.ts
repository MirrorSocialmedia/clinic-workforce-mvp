// ============================================================
// ★ cwm-paycostcheck-20261014：醫生月結預覽 —— 已計入成本逐筆「有冇經核對」
//   同「成本錄入」一模一樣嘅判斷（老闆：成本錄入綠，呢度都要綠）：
//     綠 = 同 Lab invoice 配對咗（MATCHED 行、invoice 未作廢），或者月結單已確認、配對到、價錢冇改（OK）
//     黃 = 月結單確認咗但冇呢筆（MISSING）／確認之後改咗價（CHANGED）
//     冇標示 = 仲未有月結單／invoice
//   逐間 Lab 再出成本錄入同款「月結已核對／對緊／有 $X 唔喺月結單」標示（costStatementMarks）。
//   只讀；唔郁計數。
// ============================================================
import { costStatementLinks, type CostStatementLink } from '@/lib/labdoc/cost-statement-links'
import { costStatementMarks, type StatementMark } from '@/lib/labdoc/cost-statement-marks'
import type { CostDetail, CostRow } from './cost-detail'

export interface CostCheck {
  green: boolean
  /** 月結單逐筆核對（null = 冇已確認月結單分段涉及呢筆） */
  statement: CostStatementLink | null
  /** 配對咗嘅 Lab invoice（未作廢） */
  invoices: Array<{ id: string; docNo: string | null }>
}

/** 純函數：同成本錄入行底色一樣 —— invoice 配對咗或者月結 OK 就綠 */
export function pickCostCheck(statement: CostStatementLink | null, invoices: Array<{ id: string; docNo: string | null }>): CostCheck {
  return { green: invoices.length > 0 || statement?.state === 'OK', statement, invoices }
}

export interface CostCheckSummary { green: number; warn: number; none: number }

/** 純函數：已計入嘅單有幾多綠／黃／未有 */
export function summarizeChecks(rows: Array<{ check?: CostCheck }>): CostCheckSummary {
  let green = 0, warn = 0, none = 0
  for (const r of rows) {
    if (r.check?.green) green++
    else if (r.check?.statement && r.check.statement.state !== 'OK') warn++
    else none++
  }
  return { green, warn, none }
}

export type CheckedCostRow = CostRow & { check?: CostCheck }

/**
 * 喺 costDetail 結果嘅「已計入」行加 check；LAB 類別另加逐間 Lab 嘅月結標示（labMarks，key = 工廠名）。
 * 失敗唔影響預覽（呢啲只係標示）—— caller 自己 catch。
 */
export async function annotateCostChecks(client: any, detail: CostDetail, providerId: string, clinicId: string, periodMonth: string) {
  const rows: CheckedCostRow[] = Object.values(detail).flatMap(d => d.counted as CheckedCostRow[])
  if (rows.length === 0) return { labMarks: {} as Record<string, StatementMark>, summary: {} as Record<string, CostCheckSummary> }
  const ids = rows.map(r => r.id)
  const [cases, lines] = await Promise.all([
    client.costCase.findMany({
      where: { id: { in: ids } },
      select: { id: true, labId: true, clinicId: true, providerId: true, periodMonth: true, finalCost: true, status: true, lab: { select: { name: true } } },
    }),
    client.labDocumentLine.findMany({
      where: { costCaseId: { in: ids }, status: 'MATCHED', document: { kind: 'INVOICE', status: { not: 'VOID' } } },
      select: { costCaseId: true, document: { select: { id: true, docNo: true } } },
    }),
  ])
  const links = await costStatementLinks(client, cases.map((c: any) => ({
    id: c.id, labId: c.labId, clinicId: c.clinicId, providerId: c.providerId, periodMonth: c.periodMonth,
    finalCost: c.finalCost == null ? null : Number(c.finalCost), status: c.status,
  })))
  const invByCase = new Map<string, Array<{ id: string; docNo: string | null }>>()
  for (const l of lines) {
    if (!l.costCaseId || !l.document) continue
    const arr = invByCase.get(l.costCaseId) ?? []
    if (!arr.some(x => x.id === l.document.id)) arr.push({ id: l.document.id, docNo: l.document.docNo ?? null })
    invByCase.set(l.costCaseId, arr)
  }
  for (const r of rows) r.check = pickCostCheck(links.get(r.id) ?? null, invByCase.get(r.id) ?? [])

  // 逐間 Lab 月結標示（同成本錄入頁底一樣；只計 LAB，月結單按到貨月）
  const labIdByName = new Map<string, string>()
  for (const c of cases) if (c.labId && c.lab?.name) labIdByName.set(c.lab.name, c.labId)
  const marks = labIdByName.size
    ? await costStatementMarks(client, { month: periodMonth, labIds: [...labIdByName.values()], clinicIds: [clinicId], providerId })
    : {}
  const labMarks: Record<string, StatementMark> = {}
  for (const [name, id] of labIdByName) if ((marks as any)[id]) labMarks[name] = (marks as any)[id]

  const summary: Record<string, CostCheckSummary> = {}
  for (const [cat, d] of Object.entries(detail)) summary[cat] = summarizeChecks(d.counted as CheckedCostRow[])
  return { labMarks, summary }
}
