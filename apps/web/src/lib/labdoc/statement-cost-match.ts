/**
 * cwm-labdoc — 月結單 ⇄ 成本錄入 對數（純函數，零 IO）
 *
 * 2026-10-11 用家拍板：月結單唔使準確到病人，同「成本錄入」對總數就得；invoice 先逐個病人對。
 *
 * 範圍（route 層查好 costs 傳入）：同 Lab ＋ 同診所 ＋ 同醫生 ＋ periodMonth（到貨日月份）＝ 月結單月份，唔計 VOID。
 *
 * 第 1 步（決定狀態）：月結單計數總數 vs Σ 成本（finalCost；冇數當 0）；差 ≤ $0.01 → OK，否則 DIFF。
 *   - 計數行 = INVOICE／CREDIT／CHARGE（欠款型只計本月：agingBucket CURRENT，冇 bucket 就睇日期）
 *   - 標咗「備貨」（STOCK）或者「唔關我哋事」（NOT_OURS）嘅行唔計（備貨唔會入成本錄入）
 *   - $0 行、PAYMENT／BF、舊欠 → NOT_APPLICABLE
 * 第 2 步（只係提示，唔影響狀態）：唔理病人，按金額劃埋 —
 *   一筆成本 = 一行，或者 = 連續幾行加埋（同一個病人通常連住寫）→ 行 MATCHED；剩低嘅行 UNPAIRED、成本列出。
 */

export const EXCLUDE_RESOLUTIONS = new Set(['STOCK', 'NOT_OURS'])
const COUNTED_TYPES = new Set(['INVOICE', 'CREDIT', 'CHARGE'])
const EPS = 0.01
/** 連續行配對最多睇幾多行（一個病人通常唔會超過呢個數） */
const MAX_RUN = 40

export interface CostLineIn {
  id: string
  lineIndex: number
  lineType: string
  amount: number
  qty: number | null
  unitPrice: number | null
  date: Date | null
  agingBucket: string | null
  resolution: string | null
}

export interface CostCaseIn {
  id: string
  patientCode: string | null
  itemType: string | null
  finalCost: number | null
  status: string
  receivedAt: Date | null
}

export type CostLineResult = 'MATCHED' | 'UNPAIRED' | 'NOT_APPLICABLE'

export interface CostMatchOutput {
  status: 'OK' | 'DIFF'
  /** 月結單計數總數（唔計備貨／唔關我哋事） */
  statementTotal: number
  /** Σ 成本錄入 */
  costTotal: number
  diff: number
  /** 標咗備貨嘅金額 */
  stockTotal: number
  /** 標咗唔關我哋事嘅金額 */
  notOursTotal: number
  /** 行結果（每行一個） */
  lines: Array<{ id: string; result: CostLineResult; costCaseId: string | null }>
  /** 劃埋咗嘅組合 */
  pairs: Array<{ costCaseId: string; lineIds: string[] }>
  unpairedCostIds: string[]
  /** 成本「未有價」（status PENDING 或者冇 finalCost）嘅筆數 */
  unpricedCount: number
  /** 讀數檢查：月結單印咗嘅總數 vs 行加埋（唔理備貨標記）；冇印 → null */
  readCheck: { stated: number; linesSum: number; ok: boolean } | null
}

const r2 = (n: number) => Math.round(n * 100) / 100
const eq = (a: number, b: number) => Math.abs(a - b) <= EPS

function inStatementMonth(d: Date, month: string): boolean {
  return d.toISOString().slice(0, 7) === month
}

/** 呢行喺唔喺月結單「本月」範圍（欠款型先有分別）。 */
export function lineInScope(l: CostLineIn, all: CostLineIn[], outstanding: boolean, month: string): boolean {
  if (!COUNTED_TYPES.has(l.lineType)) return false
  if (!outstanding) return true
  const anyBucket = all.some((x) => x.agingBucket != null)
  if (anyBucket) return l.agingBucket === 'CURRENT'
  return l.date ? inStatementMonth(l.date, month) : false
}

/** 月結單冇印數量 → 金額 ÷ 單價（整除先用；否則 null）。 */
export function deriveQty(qty: number | null, unitPrice: number | null, amount: number): number | null {
  if (qty != null) return qty
  if (!unitPrice || Math.abs(unitPrice) < EPS) return null
  const q = amount / unitPrice
  const rq = Math.round(q)
  return rq > 0 && Math.abs(q - rq) < 1e-6 ? rq : null
}

export function matchStatementToCosts(input: {
  lines: CostLineIn[]
  costs: CostCaseIn[]
  outstanding: boolean
  statementMonth: string
  statedTotal: number | null
}): CostMatchOutput {
  const lines = [...input.lines].sort((a, b) => a.lineIndex - b.lineIndex)
  const scoped = lines.filter((l) => lineInScope(l, lines, input.outstanding, input.statementMonth))
  const counted = scoped.filter((l) => !(l.resolution && EXCLUDE_RESOLUTIONS.has(l.resolution)))
  const stockTotal = r2(scoped.filter((l) => l.resolution === 'STOCK').reduce((s, l) => s + l.amount, 0))
  const notOursTotal = r2(scoped.filter((l) => l.resolution === 'NOT_OURS').reduce((s, l) => s + l.amount, 0))
  const statementTotal = r2(counted.reduce((s, l) => s + l.amount, 0))
  const costTotal = r2(input.costs.reduce((s, c) => s + (c.finalCost ?? 0), 0))
  const diff = r2(statementTotal - costTotal)
  const unpricedCount = input.costs.filter((c) => c.finalCost == null || c.status === 'PENDING').length

  // 第 2 步：配對（$0 行唔參與）
  const pairable = counted.filter((l) => Math.abs(l.amount) > EPS)
  const used = new Set<string>()
  const lineCost = new Map<string, string>()
  const pairs: Array<{ costCaseId: string; lineIds: string[] }> = []
  const costs = [...input.costs]
    .filter((c) => c.finalCost != null && Math.abs(c.finalCost) > EPS)
    .sort((a, b) => (a.receivedAt?.getTime() ?? 0) - (b.receivedAt?.getTime() ?? 0) || a.id.localeCompare(b.id))
  const pairedCost = new Set<string>()
  // (a) 一筆成本 = 一行
  for (const c of costs) {
    const hit = pairable.find((l) => !used.has(l.id) && eq(l.amount, c.finalCost!))
    if (!hit) continue
    used.add(hit.id)
    lineCost.set(hit.id, c.id)
    pairedCost.add(c.id)
    pairs.push({ costCaseId: c.id, lineIds: [hit.id] })
  }
  // (b) 一筆成本 = 連續幾行（喺未用嘅行之中連續）
  for (const c of costs) {
    if (pairedCost.has(c.id)) continue
    const free = pairable.filter((l) => !used.has(l.id))
    let found: CostLineIn[] | null = null
    for (let i = 0; i < free.length && !found; i++) {
      let sum = 0
      for (let j = i; j < free.length && j - i < MAX_RUN; j++) {
        sum += free[j].amount
        if (j > i && eq(sum, c.finalCost!)) {
          found = free.slice(i, j + 1)
          break
        }
      }
    }
    if (!found) continue
    for (const l of found) {
      used.add(l.id)
      lineCost.set(l.id, c.id)
    }
    pairedCost.add(c.id)
    pairs.push({ costCaseId: c.id, lineIds: found.map((l) => l.id) })
  }

  const countedIds = new Set(counted.map((l) => l.id))
  const outLines = lines.map((l) => {
    const cc = lineCost.get(l.id) ?? null
    let result: CostLineResult
    if (!countedIds.has(l.id) || Math.abs(l.amount) <= EPS) result = 'NOT_APPLICABLE'
    else result = cc ? 'MATCHED' : 'UNPAIRED'
    return { id: l.id, result, costCaseId: cc }
  })

  let readCheck: CostMatchOutput['readCheck'] = null
  if (input.statedTotal != null) {
    const linesSum = r2(scoped.reduce((s, l) => s + l.amount, 0))
    readCheck = { stated: input.statedTotal, linesSum, ok: eq(linesSum, input.statedTotal) }
  }

  return {
    status: eq(statementTotal, costTotal) ? 'OK' : 'DIFF',
    statementTotal,
    costTotal,
    diff,
    stockTotal,
    notOursTotal,
    lines: outLines,
    pairs,
    unpairedCostIds: input.costs.filter((c) => !pairedCost.has(c.id)).map((c) => c.id),
    unpricedCount,
    readCheck,
  }
}
