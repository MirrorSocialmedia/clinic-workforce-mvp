/**
 * cwm-labdoc P2 CHUNK 3 — Invoice 對成本純函數（§7.3 候選排序／§7.4 預設／§7.5 核對動作／
 * §7.6 新增成本預填／§3.4 文件狀態重算）
 *
 * 🔴 全部純函數：冇 DB、冇 side effect — route 層負責撈數據再傳入。
 * 測試：reconcile.test.ts（同一份邏輯 route 同測試共用）。
 */
import { MONEY_EPS } from './validate-extract'

// ------------------------------------------------------------------
// §7.3 候選成本排序
// ------------------------------------------------------------------

export interface CandidateCost {
  id: string
  /** null = 未有價 */
  baseCost: number | null
  /** 未到貨 = null（「已到貨排先」） */
  receivedAt: Date | null
  orderedAt: Date
  /** 已有 MAIN 連結（其他單）— §7.3：仍然係候選，但揀佢要揀連結類型（B7） */
  hasMainLink: boolean
}

/**
 * §7.3 排序（跟 spec SQL 逐行對應）：
 *   (baseCost = groupSum) DESC,   -- 金額一樣排第一（F-06）
 *   (receivedAt IS NULL) ASC,     -- 已到貨排先
 *   orderedAt DESC
 * 回排序後 id 陣列。
 */
export function rankCandidateIds(
  candidates: Array<Pick<CandidateCost, 'id' | 'baseCost' | 'receivedAt' | 'orderedAt'>>,
  groupSum: number,
): string[] {
  // 金額係 2 位小數 — 先 round2 再比（浮點 500-499.99=0.010000000000005 唔會喺邊界誤殺）
  const isExact = (baseCost: number | null): boolean =>
    baseCost !== null && Math.abs(round2(baseCost - groupSum)) <= MONEY_EPS
  return [...candidates]
    .sort((a, b) => {
      // 逐 key：金額一樣 DESC → 已到貨 DESC → orderedAt DESC → id 字典序（決定性）
      const e = Number(isExact(b.baseCost)) - Number(isExact(a.baseCost))
      if (e !== 0) return e
      const r = Number(a.receivedAt === null) - Number(b.receivedAt === null)
      if (r !== 0) return r
      const o = b.orderedAt.getTime() - a.orderedAt.getTime()
      if (o !== 0) return o
      return a.id.localeCompare(b.id)
    })
    .map((c) => c.id)
}

// ------------------------------------------------------------------
// §7.4 預設
// ------------------------------------------------------------------

export interface GroupLineInput {
  lineId: string
  amount: number
  isZero: boolean
}

export type LineAction = 'MATCH' | 'IGNORE' | 'UNMATCH'

export interface DefaultSelection {
  /** 每行預設動作（行 id → action + 目標成本） */
  lineActions: Array<{ lineId: string; action: LineAction; costCaseId: string | null; linkType: 'MAIN' | null }>
  /** 預設選中嗰筆成本（null = 冇預設） */
  selectedCostCaseId: string | null
  /** 候選 0 → 顯示「新增成本」 */
  showNewCase: boolean
  /** 候選 0 → 顯示「搵其他病人」 */
  showPatientSearch: boolean
}

/**
 * §7.4 預設（保守口徑，決策入 decision log）：
 * - 分組所有行預設剔（UNMATCH）。
 * - 候選 1 筆而且**未有 MAIN 連結** → 全部行預設對佢（MAIN）。
 *   （1 筆但已有 MAIN 連結 → 冇預設 — 揀佢要揀補收費／重做類型，唔自動。）
 * - 候選 >1 → 預設揀「baseCost = 分組合計」嗰筆（**剛好一筆**而且冇 MAIN 連結）；否則冇預設。
 * - 候選 0 → showNewCase ＋ showPatientSearch。
 * - $0 行：預設剔、跟同組其他行連同一筆成本（D11）— 即預設 MATCH 時 $0 行一齊 MATCH（唔影響金額）。
 */
export function defaultGroupSelection(
  lines: GroupLineInput[],
  rankedCandidates: Array<Pick<CandidateCost, 'id' | 'baseCost' | 'hasMainLink'>>,
  groupSum: number,
): DefaultSelection {
  const unmatchAll = (): DefaultSelection => ({
    lineActions: lines.map((l) => ({ lineId: l.lineId, action: 'UNMATCH' as const, costCaseId: null, linkType: null })),
    selectedCostCaseId: null,
    showNewCase: rankedCandidates.length === 0,
    showPatientSearch: rankedCandidates.length === 0,
  })

  if (rankedCandidates.length === 0) return unmatchAll()

  let selected: string | null = null
  if (rankedCandidates.length === 1) {
    const c = rankedCandidates[0]
    if (!c.hasMainLink) selected = c.id
  } else {
    const exact = rankedCandidates.filter(
      (c) => !c.hasMainLink && c.baseCost !== null && Math.abs(round2(c.baseCost - groupSum)) <= MONEY_EPS,
    )
    if (exact.length === 1) selected = exact[0].id
  }

  if (selected === null) return unmatchAll()
  return {
    lineActions: lines.map((l) => ({
      lineId: l.lineId,
      action: 'MATCH' as const,
      costCaseId: selected,
      // $0 行跟同組（D11）— 一律 MAIN
      linkType: 'MAIN' as const,
    })),
    selectedCostCaseId: selected,
    showNewCase: false,
    showPatientSearch: false,
  }
}

// ------------------------------------------------------------------
// §7.5 每筆成本嘅核對同動作
// ------------------------------------------------------------------

export type PriceDecision =
  | { kind: 'LOCKED'; linkedSum: number; /** linkedSum ≠ baseCost → 待處理「下期調整」 */ diff: number | null }
  | { kind: 'EQUAL'; linkedSum: number }
  | { kind: 'NO_PRICE'; linkedSum: number }
  /** 金額唔同 → 「改做 $linkedSum」；otherExactMatch = 另一筆候選 baseCost 剛好 = 分組合計 → 紅字警示 */
  | { kind: 'DIFF'; linkedSum: number; baseCost: number; otherExactMatch: boolean }

/**
 * §7.5：`linkedSum(cc)` = 該成本**所有** MATCHED 行（包括其他 invoice 嘅補收費／重做）
 * ＋今次要連嘅行嘅 amount 總和。
 */
export function computeLinkedSum(existingMatchedAmounts: number[], addingAmounts: number[]): number {
  return Math.round((existingMatchedAmounts.reduce((a, b) => a + b, 0) + addingAmounts.reduce((a, b) => a + b, 0)) * 100) / 100
}

export function priceDecision(input: {
  lockedByRunId: string | null
  baseCost: number | null
  linkedSum: number
  /** 其他候選（除自己外）有冇 baseCost = 分組合計 — 紅字「金額同 {另一筆} 一致，係咪揀錯？」 */
  anotherCandidateExactMatch: boolean
}): PriceDecision {
  const { lockedByRunId, baseCost, linkedSum, anotherCandidateExactMatch } = input
  if (lockedByRunId !== null) {
    return { kind: 'LOCKED', linkedSum, diff: baseCost === null ? null : round2(linkedSum - baseCost) }
  }
  if (baseCost === null) return { kind: 'NO_PRICE', linkedSum }
  if (Math.abs(round2(baseCost - linkedSum)) <= MONEY_EPS) return { kind: 'EQUAL', linkedSum }
  return { kind: 'DIFF', linkedSum, baseCost, otherExactMatch: anotherCandidateExactMatch }
}

export const round2 = (n: number): number => Math.round(n * 100) / 100

// ------------------------------------------------------------------
// §7.6 新增成本預填
// ------------------------------------------------------------------

export interface NewCasePrefill {
  category: 'LAB' // 鎖死（F-25）
  clinicId: string
  providerId: string
  labId: string | null
  patientCode: string
  patientCodeNorm: string
  /** PatientIndex 系統姓名（冇就 null；**唔用** invoice 拼音） */
  patientName: string | null
  labOrderNo: string | null
  itemType: string
  baseCost: number
  finalCost: number
  /** orderReceivedDate ?? docDate（畫面標「估計」） */
  orderedAt: Date
  status: 'PRICED'
  source: 'MANUAL'
  labInvoiceLinked: true
}

/**
 * §7.6 預填規則（必填欄由 route 層驗證）：
 * - clinicId / providerId / patientCode / patientCodeNorm / itemType 係必填 — 缺咗 route 層 400
 * - baseCost = 分組合計、finalCost = baseCost → status PRICED（跟 cost-cases POST 口徑：baseCost 有值 = PRICED）
 * - orderedAt = orderReceivedDate ?? docDate
 */
export function prefillNewCase(input: {
  clinicId: string
  providerId: string
  labId: string | null
  patientCode: string
  patientCodeNorm: string
  systemPatientName: string | null
  labCaseRef: string | null
  groupSum: number
  orderReceivedDate: Date | null
  docDate: Date | null
  itemType: string
}): NewCasePrefill {
  const orderedAt = input.orderReceivedDate ?? input.docDate
  if (!orderedAt) throw new Error('prefillNewCase: orderReceivedDate ?? docDate 必須有值')
  const baseCost = round2(input.groupSum)
  return {
    category: 'LAB',
    clinicId: input.clinicId,
    providerId: input.providerId,
    labId: input.labId,
    patientCode: input.patientCode,
    patientCodeNorm: input.patientCodeNorm,
    patientName: input.systemPatientName ?? null,
    labOrderNo: input.labCaseRef ?? null,
    itemType: input.itemType,
    baseCost,
    finalCost: baseCost,
    orderedAt,
    status: 'PRICED',
    source: 'MANUAL',
    labInvoiceLinked: true,
  }
}

// ------------------------------------------------------------------
// §3.4 文件狀態重算（CONFIRMED/PARTIAL/RECONCILED 之間）
// ------------------------------------------------------------------

/**
 * §3.4：全部 MATCHED/IGNORED → RECONCILED；有 MATCHED/IGNORED 但未齊 → PARTIAL；
 * 冇任何 MATCHED/IGNORED → CONFIRMED。
 */
export function recomputeInvoiceDocStatus(lineStatuses: string[]): 'RECONCILED' | 'PARTIAL' | 'CONFIRMED' {
  const done = lineStatuses.filter((s) => s === 'MATCHED' || s === 'IGNORED').length
  if (lineStatuses.length === 0 || done === 0) return 'CONFIRMED'
  return done === lineStatuses.length ? 'RECONCILED' : 'PARTIAL'
}
