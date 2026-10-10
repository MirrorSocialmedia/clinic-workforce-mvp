/**
 * cwm-labdoc P2 — §5.5 讀單後系統檢查（純函數；CWM 側，m-6 驗收項）
 *
 * 行序：zod 驗證 → 敏感數字過濾（§5.6）→ 本檢查 → 寫 extractedJson／欄位。
 *
 * 結果持久化口徑（DB 只存 doc 級 readIssues token；行/段級細節由 UI 用同一套
 * 純函數對住已存嘅行重算 — 唔另開表）：
 *  - readIssues token（合併入 LabDocument.readIssues）：
 *      AMOUNT_TOO_LARGE（§5.4：|amount| > 1,000,000，該行標紅要人手確認）
 *      TOTAL_MISMATCH ／ TOTAL_MISSING（F-16）／ DATE_SUSPICIOUS ／ KIND_MISMATCH
 *    （CHEQUE_PRESENT 係 LLM 自己喺 readIssues 入面寫嘅 — 照樣 pass-through，
 *      UI 見 token 就紅：「相入面有支票。請裁走支票再上傳…」；lab_statement 可放行 = P3 流）
 *  - blocking ≠ ∅ → §7.1 確認頭部擋住（409/400，UI 顯示「差 $X」）
 *  - lineFlags／sectionFlags／totalDiff：給 UI 顏色排序用（最可疑嘅行 = qty×unitPrice 唔等，排頭）
 */
import type { LabDocResult } from './schema'

/** §5.4：|amount| 超過呢個數 → readIssue AMOUNT_TOO_LARGE ＋ 行標紅 */
export const AMOUNT_TOO_LARGE_LIMIT = 1_000_000
/** §5.5：date 喺上傳日前 400 日內 */
export const DATE_PAST_DAYS = 400
/** §5.5：date 唔喺未來 > 7 日 */
export const DATE_FUTURE_DAYS = 7
/** 金額比較容差（±0.01） */
export const MONEY_EPS = 0.01

const DAY_MS = 86_400_000
const round2 = (n: number): number => Math.round(n * 100) / 100

export interface ExtractLineFlag {
  groupIndex: number
  lineIndex: number
  issues: Array<'QTY_MISMATCH' | 'AMOUNT_TOO_LARGE'>
}
export interface ExtractSectionFlag {
  sectionIndex: number
  issue: 'SUM_MISMATCH' | 'CURRENT_MISMATCH'
  /** 行總和 − 分段宣告數（負 = 少咗） */
  diff: number
}
export interface ExtractCheckResult {
  /** 要合併入 doc.readIssues 嘅系統 token（已去重） */
  readIssues: string[]
  lineFlags: ExtractLineFlag[]
  sectionFlags: ExtractSectionFlag[]
  /** INVOICE：Σ 行 − expected（只喺 mismatch 時有值） */
  totalDiff: number | null
  /** §7.1：非空 → 擋確認（TOTAL_MISMATCH / TOTAL_MISSING） */
  blocking: string[]
}

export interface CheckExtractedOpts {
  /** 上傳時揀嘅分頁（§5.5「kind ≠ 上傳時揀嘅分頁」） */
  docKind: 'INVOICE' | 'STATEMENT'
  /** 上傳時間（date 範圍檢查基準） */
  uploadedAt: Date
  /** LabProfile.statementKind（Lab 識別到先有值）；OUTSTANDING 用 currentTotal 檢查 */
  statementKind?: 'DETAIL' | 'INVOICE_LIST' | 'OUTSTANDING' | null
}

/**
 * §5.5 全檢查。純函數：同樣入參永遠同樣出參（UI 重算同 runner 寫入用同一份邏輯）。
 */
export function checkExtracted(result: LabDocResult, opts: CheckExtractedOpts): ExtractCheckResult {
  const readIssues: string[] = []
  const lineFlags: ExtractLineFlag[] = []
  const sectionFlags: ExtractSectionFlag[] = []
  const blocking: string[] = []
  let totalDiff: number | null = null

  const addReadIssue = (t: string): void => {
    if (!readIssues.includes(t)) readIssues.push(t)
  }

  // ① 每行 qty × unitPrice = amount（齊先查，±0.01）→ 行黃色；§5.4 |amount| > 1M → 行紅
  const checkLine = (gi: number, li: number, qty: number | null, unitPrice: number | null, amount: number): void => {
    const issues: Array<'QTY_MISMATCH' | 'AMOUNT_TOO_LARGE'> = []
    if (qty !== null && unitPrice !== null && Math.abs(qty * unitPrice - amount) > MONEY_EPS) {
      issues.push('QTY_MISMATCH')
    }
    if (Math.abs(amount) > AMOUNT_TOO_LARGE_LIMIT) {
      issues.push('AMOUNT_TOO_LARGE')
      addReadIssue('AMOUNT_TOO_LARGE')
    }
    if (issues.length > 0) lineFlags.push({ groupIndex: gi, lineIndex: li, issues })
  }

  let invoiceSum = 0
  for (let gi = 0; gi < result.groups.length; gi++) {
    const lines = result.groups[gi].lines
    for (let li = 0; li < lines.length; li++) {
      invoiceSum += lines[li].amount
      checkLine(gi, li, lines[li].qty, lines[li].unitPrice, lines[li].amount)
    }
  }

  if (result.kind === 'INVOICE') {
    // ② Σ 行 amount = total（或 subtotal）→ 擋確認「差 $X」；
    // ③ total、subtotal 都係 null → 擋確認（F-16：要員工填總數）
    const expected = result.total ?? result.subtotal
    if (expected === null) {
      blocking.push('TOTAL_MISSING')
      addReadIssue('TOTAL_MISSING')
    } else {
      const diff = round2(invoiceSum - expected)
      if (Math.abs(diff) > MONEY_EPS) {
        totalDiff = diff
        blocking.push('TOTAL_MISMATCH')
        addReadIssue('TOTAL_MISMATCH')
      }
    }
  }

  if (result.kind === 'STATEMENT') {
    // ④ 每段 Σ 行 amount（INVOICE＋CREDIT＋CHARGE）= section total；
    //    OUTSTANDING：Σ CURRENT = currentTotal → 分段紅「月結單讀數唔齊（差 $X）」
    result.sections.forEach((s, si) => {
      if (opts.statementKind === 'OUTSTANDING') {
        if (s.currentTotal !== null) {
          const sum = s.lines.filter((l) => l.agingBucket === 'CURRENT').reduce((a, l) => a + l.amount, 0)
          const diff = round2(sum - s.currentTotal!)
          if (Math.abs(diff) > MONEY_EPS) {
            sectionFlags.push({ sectionIndex: si, issue: 'CURRENT_MISMATCH', diff })
          }
        }
      } else {
        if (s.total !== null) {
          const sum = s.lines
            .filter((l) => l.lineType === 'INVOICE' || l.lineType === 'CREDIT' || l.lineType === 'CHARGE')
            .reduce((a, l) => a + l.amount, 0)
          const diff = round2(sum - s.total!)
          if (Math.abs(diff) > MONEY_EPS) {
            sectionFlags.push({ sectionIndex: si, issue: 'SUM_MISMATCH', diff })
          }
        }
      }
    })
  }

  // ⑤ date 範圍：上傳日前 400 日內、唔喺未來 > 7 日 → 黃色
  if (result.date) {
    const d = new Date(`${result.date}T00:00:00Z`).getTime()
    const up = opts.uploadedAt.getTime()
    if (up - d > DATE_PAST_DAYS * DAY_MS || d - up > DATE_FUTURE_DAYS * DAY_MS) {
      addReadIssue('DATE_SUSPICIOUS')
    }
  }

  // ⑥ kind ≠ 上傳時揀嘅分頁 → 提示「似係月結單，轉去月結單？」（一撳轉，重新讀）
  if (result.kind !== opts.docKind) {
    addReadIssue('KIND_MISMATCH')
  }

  return { readIssues, lineFlags, sectionFlags, totalDiff, blocking }
}
