/**
 * cwm-labdoc P2 — §7.1 確認頭部：§5.5 擋確認條件 + 警告（純函數，unit 可測）。
 *
 * 擋確認（→ 400）：
 *   - INVOICE：Σ 行 amount ≠ total（或 subtotal，±0.01）
 *   - INVOICE：total、subtotal 都 null（要員工填總數，F-16）
 *   - readIssues 有 CHEQUE_PRESENT（紅色；lab_statement 放行係 P3 月結單範圍）
 * 警告（黃色，唔擋）：
 *   - 行 qty × unitPrice ≠ amount（±0.01）
 *   - date 喺上傳日前 400 日以上、或喺未來 > 7 日
 */

const EPS = 0.01

export function moneyEq(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false
  return Math.abs(a - b) <= EPS
}

export interface ConfirmLineLike {
  qty: number | null
  unitPrice: number | null
  amount: number
}

export interface ConfirmDocLike {
  kind: string
  total: number | null
  subtotal: number | null
  docDate: Date | null
  readIssues: string[]
  createdAt: Date
}

export interface ConfirmCheckResult {
  /** §5.5 擋確認原因（非空 → 400） */
  blockers: string[]
  /** 黃色警告（顯示用） */
  warnings: string[]
  /** Σ 行 amount */
  lineSum: number
}

const MS_DAY = 24 * 3600 * 1000

export function getConfirmCheckResult(doc: ConfirmDocLike, lines: ConfirmLineLike[]): ConfirmCheckResult {
  const blockers: string[] = []
  const warnings: string[] = []

  const lineSum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)

  // —— 行級 qty×unitPrice 檢查（兩種 kind；黃色）——
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.qty != null && l.unitPrice != null) {
      const expect = l.qty * l.unitPrice
      if (!moneyEq(expect, l.amount)) {
        warnings.push(`第 ${i + 1} 行 qty × unitPrice ≠ amount（$${expect.toFixed(2)} vs $${Number(l.amount).toFixed(2)}）`)
      }
    }
  }

  // —— 日期窗口（黃色）——
  if (doc.docDate) {
    const created = doc.createdAt.getTime()
    if (created - doc.docDate.getTime() > 400 * MS_DAY) warnings.push('單據日期喺上傳日前 400 日以上')
    if (doc.docDate.getTime() - created > 7 * MS_DAY) warnings.push('單據日期喺未來超過 7 日')
  }

  if (doc.kind === 'INVOICE') {
    // —— 擋確認：總數 ——
    if (doc.total == null && doc.subtotal == null) {
      blockers.push('總數同小計都係空 — 請填總數')
    } else {
      const ref = doc.total ?? doc.subtotal!
      if (!moneyEq(lineSum, ref)) {
        blockers.push(`差 $${Math.abs(lineSum - ref).toFixed(2)}：行金額合計 $${lineSum.toFixed(2)} ≠ 總數 $${ref.toFixed(2)}`)
      }
    }
    // —— 擋確認：支票 ——
    if (doc.readIssues.includes('CHEQUE_PRESENT')) {
      blockers.push('相入面有支票。請裁走支票再上傳（存底唔應該有已簽名支票）。')
    }
  }
  // STATEMENT 分段檢查屬 P3（§8）— 呢度唔擋。

  return { blockers, warnings, lineSum }
}

/**
 * §7.1：任何金額或總數同 AI 原值唔同 → manualAmountEdit = true。
 * 比對 extractedJson（AI 原始輸出，寫一次唔改）；行按 (groupIndex,lineIndex) 對。
 * 一旦設過唔會自動除（pending「人手改數待覆核」先清）。
 */
export function computeManualAmountEdit(
  extractedJson: any,
  next: { total: number | null; subtotal: number | null; lines: Array<{ groupIndex: number; lineIndex: number; amount: number }> },
  prevFlag: boolean,
): boolean {
  if (prevFlag) return true
  if (!extractedJson || typeof extractedJson !== 'object') return false
  const ai = extractedJson
  if (ai.total != null && next.total != null && !moneyEq(Number(ai.total), next.total)) return true
  if (ai.subtotal != null && next.subtotal != null && !moneyEq(Number(ai.subtotal), next.subtotal)) return true
  if (Array.isArray(ai.groups)) {
    const aiByPos = new Map<string, number>()
    // ★ extractedJson 嘅 groups（§5.4）冇 groupIndex 欄 — 用陣列 order 對應分組
    ai.groups.forEach((g: any, gi: number) => {
      const gl = Array.isArray(g?.lines) ? g.lines : []
      gl.forEach((l: any, li: number) => {
        if (l?.amount != null) aiByPos.set(`${gi}:${li}`, Number(l.amount))
      })
    })
    for (const l of next.lines) {
      const aiAmount = aiByPos.get(`${l.groupIndex}:${l.lineIndex}`)
      if (aiAmount != null && !moneyEq(aiAmount, l.amount)) return true
    }
  }
  return false
}
