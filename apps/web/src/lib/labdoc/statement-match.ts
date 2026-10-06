/**
 * cwm-labdoc P3 — §8.2 月結單配對（純函數＋單元測試）
 *
 * 三型（LabProfile.statementKind）：
 *  A. INVOICE_LIST — 逐行（每行 = 一張 invoice）：docNo 相等→金額比對；fallback 日期±3 日＋金額；多候選→NEEDS_MANUAL
 *  B. DETAIL — 逐 docNo 分組→逐行 norm(description)+toothRaw 配對；qty/unitPrice/amount 分級 DIFF；系統有月結單冇→虛擬結果
 *  C. OUTSTANDING — CURRENT 照 A；其他→之前已確認分段 MATCHED 過同單號→PREVIOUSLY_MATCHED；否則照 A；總數比 statedCurrent
 *
 * 共通：
 *  - PAYMENT/BF → NOT_APPLICABLE（唔配對、唔計總數）；CHARGE → NEEDS_MANUAL；CREDIT 照配對（負數）
 *  - systemTotal = 所有 MATCHED/*_DIFF 行對到嘅系統金額
 *  - 反向（月結單冇）：範圍內系統 invoice 喺 statementMonth 但冇被任何行配對 → notOnStatement
 *    （入待處理要 M 同 M+1 都 CONFIRMED — CHUNK 6 pending 層判定，呢度只供數據）
 *
 * 重跑（POST …/reconcile）：已有 resolution 嘅行由 route 層保留（只覆寫無 resolution 行）。
 *
 * 零 DB：系統 invoice 範圍（同 lab/clinic/provider＋docDate ∈ [月初−45 日, 月尾+10 日]）由 route 層預先查好傳入。
 */

export type StatementKind = 'INVOICE_LIST' | 'DETAIL' | 'OUTSTANDING'

export type LineType = 'INVOICE' | 'CREDIT' | 'PAYMENT' | 'CHARGE' | 'BF'

export type MatchResult =
  | 'MATCHED'
  | 'QTY_DIFF'
  | 'PRICE_DIFF'
  | 'AMOUNT_DIFF'
  | 'MISSING_IN_SYSTEM'
  | 'PREVIOUSLY_MATCHED'
  | 'NEEDS_MANUAL'
  | 'NOT_APPLICABLE'

export type MatchBasis = 'DOC_NO' | 'FALLBACK' | 'MANUAL'

// ------------------------------------------------------------------
// 輸入形狀（route 層由 DB 映射；Decimal → number 先傳入）
// ------------------------------------------------------------------

export interface SystemLine {
  id: string
  description: string
  toothRaw: string | null
  qty: number | null
  unitPrice: number | null
  amount: number
  patientCode: string | null
}

export interface SystemInvoice {
  id: string
  docNo: string | null
  docDate: Date | null
  total: number | null
  lines: SystemLine[]
}

export interface StatementLineRow {
  id: string
  lineIndex: number
  lineType: LineType
  docNo: string | null
  date: Date | null
  patientCode: string | null
  description: string | null
  toothRaw: string | null
  qty: number | null
  unitPrice: number | null
  amount: number
  agingBucket: string | null
}

export interface SectionCtx {
  kind: StatementKind
  statementMonth: string // 'YYYY-MM'
  /** LabProfile.statementDocNoSameAsInvoice（INVOICE_LIST 先有意義） */
  docNoSameAsInvoice: boolean
}

export interface MatchOutcome {
  lineId: string
  result: MatchResult
  matchBasis: MatchBasis | null
  matchedDocumentId: string | null
  matchedLineId: string | null // DETAIL：系統行 id
  /** 對到嘅系統金額（systemTotal 計入；PAYMENT/BF/PREVIOUSLY_MATCHED/NEEDS_MANUAL/MISSING = null） */
  systemAmount: number | null
}

/** DETAIL：系統 invoice 有、月結單組冇嘅行（虛擬結果 — 存 section 結果 JSON，唔建表）。 */
export interface VirtualLine {
  docId: string
  docNo: string | null
  systemLineId: string
  description: string
  amount: number
}

/** 反向：範圍內系統 invoice（docDate 喺 statementMonth）冇被任何月結單行配對。 */
export interface NotOnStatement {
  docId: string
  docNo: string | null
  docDate: string // YYYY-MM-DD
  total: number | null
}

export interface SectionMatchSummary {
  outcomes: MatchOutcome[]
  systemTotal: number
  /** 分段 OK 判定（§8.2）：冇 *_DIFF/MISSING/NEEDS_MANUAL 而且 stated(Total|Current) = systemTotal */
  ok: boolean
  statedForCheck: number | null
  /** DETAIL 虛擬結果（JSON 存 section 結果） */
  virtualLines: VirtualLine[]
  /** 反向（月結單冇） */
  notOnStatement: NotOnStatement[]
}

// ------------------------------------------------------------------
// 正規化
// ------------------------------------------------------------------

/** 全形 → 半形（同 identify.ts toHalfWidth 口徑 — 呢度自帶避免跨檔拖重）。 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFee0))
    .replace(/\u3000/g, ' ')
}

/** §8.2：description 正規化 — 細階、去空格、全半形、括號統一（（）→()）。 */
export function normDescription(s: string | null): string {
  if (!s) return ''
  return toHalfWidth(s)
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** §8.2：toothRaw 正規化 — 去空格後比字元集合（「16 26」=「26 16」）。 */
export function normTooth(s: string | null): string {
  if (!s) return ''
  return [...new Set(toHalfWidth(s).replace(/\s+/g, '').toLowerCase().split(''))].sort().join('')
}

/** 兩日期（日粒度）相差天數（絕對值）。 */
function dayDiff(a: Date, b: Date): number {
  const day = 24 * 3600 * 1000
  return Math.round(Math.abs(a.getTime() - b.getTime()) / day)
}

/** 日期喺唔喺 'YYYY-MM' 月內（UTC 日粒度）。 */
function inMonth(d: Date, month: string): boolean {
  return d.toISOString().slice(0, 7) === month
}

const AMT_EPS = 0.01

function eq(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= AMT_EPS
}

/** 比較一個維度：两边都非 null 先比（单边缺 → 視同相等，落下一個維度 — 保守：缺值唔算 DIFF）。 */
function dimEq(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true
  return eq(a, b)
}

function notApplicable(lineId: string): MatchOutcome {
  return { lineId, result: 'NOT_APPLICABLE', matchBasis: null, matchedDocumentId: null, matchedLineId: null, systemAmount: null }
}

function needsManual(lineId: string, basis: MatchBasis | null = null, matchedDocumentId: string | null = null): MatchOutcome {
  return { lineId, result: 'NEEDS_MANUAL', matchBasis: basis, matchedDocumentId, matchedLineId: null, systemAmount: null }
}

function missing(lineId: string, matchedDocumentId: string | null = null): MatchOutcome {
  return { lineId, result: 'MISSING_IN_SYSTEM', matchBasis: null, matchedDocumentId, matchedLineId: null, systemAmount: null }
}

// ------------------------------------------------------------------
// A. INVOICE_LIST 型配對（逐行 = 逐張 invoice）
// ------------------------------------------------------------------

function pickInvoice(
  line: StatementLineRow,
  inv: SystemInvoice,
  basis: MatchBasis,
  usedInvoiceIds: Set<string>,
): MatchOutcome {
  usedInvoiceIds.add(inv.id)
  if (inv.total === null) {
    return { ...needsManual(line.id, basis, inv.id) }
  }
  return {
    lineId: line.id,
    result: eq(inv.total, line.amount) ? 'MATCHED' : 'AMOUNT_DIFF',
    matchBasis: basis,
    matchedDocumentId: inv.id,
    matchedLineId: null,
    systemAmount: inv.total,
  }
}

function matchInvoiceListLine(
  line: StatementLineRow,
  systemInvoices: SystemInvoice[],
  ctx: { docNoSameAsInvoice: boolean },
  usedInvoiceIds: Set<string>,
): MatchOutcome {
  // 1) docNo 相等（statementDocNoSameAsInvoice 先使）
  if (ctx.docNoSameAsInvoice && line.docNo) {
    const cands = systemInvoices.filter((s) => s.docNo === line.docNo && !usedInvoiceIds.has(s.id))
    if (cands.length > 1) return { ...needsManual(line.id, 'DOC_NO') }
    if (cands.length === 1) return pickInvoice(line, cands[0], 'DOC_NO', usedInvoiceIds)
  }

  // 2) fallback：|docDate − line.date| ≤ 3 日（多候選 → 有病人編號先縮窄；再唔唯一 → NEEDS_MANUAL）
  if (line.date) {
    const lineDate = line.date
    const cands = systemInvoices.filter((s) => s.docDate !== null && dayDiff(s.docDate, lineDate) <= 3 && !usedInvoiceIds.has(s.id))
    if (cands.length > 1) {
      if (line.patientCode) {
        const withPatient = cands.filter((s) => s.lines.some((l) => l.patientCode === line.patientCode))
        if (withPatient.length === 1) return pickInvoice(line, withPatient[0], 'FALLBACK', usedInvoiceIds)
        if (withPatient.length > 1) return { ...needsManual(line.id, 'FALLBACK') }
      }
      return { ...needsManual(line.id, 'FALLBACK') }
    }
    if (cands.length === 1) return pickInvoice(line, cands[0], 'FALLBACK', usedInvoiceIds)
  }

  // 3) 未中 → MISSING_IN_SYSTEM
  return { ...missing(line.id) }
}

// ------------------------------------------------------------------
// B. DETAIL 型（docNo 分組→逐行配對）
// ------------------------------------------------------------------

/** 分級 DIFF：qty → unitPrice → amount（先比先中）。 */
export function gradeLinePair(sl: SystemLine, sline: StatementLineRow): MatchResult {
  if (!dimEq(sl.qty, sline.qty)) return 'QTY_DIFF'
  if (!dimEq(sl.unitPrice, sline.unitPrice)) return 'PRICE_DIFF'
  if (!eq(sl.amount, sline.amount)) return 'AMOUNT_DIFF'
  return 'MATCHED'
}

/** 配對分：0 = description+tooth 全中；1 = 只 description 中；2 = 唔中（按次序兜）。 */
function pairScore(sl: SystemLine, sline: StatementLineRow): number {
  const dEq = normDescription(sl.description) !== '' && normDescription(sl.description) === normDescription(sline.description)
  if (dEq && normTooth(sl.toothRaw) === normTooth(sline.toothRaw)) return 0
  if (dEq) return 1
  return 2
}

/**
 * §8.2.3：逐行配對 — norm(description)+toothRaw 優先 → 只 description → 按次序。
 * 每邊逐行配走；未配對嘅 statement 行 = MISSING_IN_SYSTEM（對到 invoice 但行唔喺度）；
 * 系統有、組冇 → virtual（§8.2.5）。
 */
function matchDetailGroup(
  groupLines: StatementLineRow[],
  inv: SystemInvoice,
): { outcomes: MatchOutcome[]; virtual: VirtualLine[] } {
  const outcomes: MatchOutcome[] = []
  const usedSystem = new Set<string>()
  const pairedStatement = new Set<string>()

  for (const score of [0, 1, 2]) {
    for (const sline of groupLines) {
      if (pairedStatement.has(sline.id)) continue
      const cands = inv.lines.filter((l) => !usedSystem.has(l.id))
      const scored = cands.map((l) => ({ l, s: pairScore(l, sline) })).filter((x) => x.s === score)
      if (scored.length === 0) continue
      const pick = scored[0].l // 同分多候選：按系統行次序（稳定）
      usedSystem.add(pick.id)
      pairedStatement.add(sline.id)
      outcomes.push({
        lineId: sline.id,
        result: gradeLinePair(pick, sline),
        matchBasis: 'DOC_NO',
        matchedDocumentId: inv.id,
        matchedLineId: pick.id,
        systemAmount: pick.amount,
      })
    }
  }
  // 未配對嘅 statement 行
  for (const sline of groupLines) {
    if (!pairedStatement.has(sline.id)) outcomes.push({ ...missing(sline.id, inv.id) })
  }
  // 系統有、月結單組冇 → 虛擬結果（§8.2.5：存 JSON 唔建表）
  const virtual: VirtualLine[] = inv.lines
    .filter((l) => !usedSystem.has(l.id))
    .map((l) => ({ docId: inv.id, docNo: inv.docNo, systemLineId: l.id, description: l.description, amount: l.amount }))
  return { outcomes, virtual }
}

// ------------------------------------------------------------------
// 主入口
// ------------------------------------------------------------------

/**
 * §8.2 分段配對（純函數）。
 * @param args.previouslyMatchedDocNos — C：之前已確認分段 MATCHED 嘅 docNo（route 層查：
 *        同 lab/clinic/provider、statementMonth 更早、section CONFIRMED、line result=MATCHED）。
 */
export function matchSection(
  ctx: SectionCtx,
  args: {
    statedTotal: number | null
    statedCurrent: number | null
    lines: StatementLineRow[]
    systemInvoices: SystemInvoice[]
    previouslyMatchedDocNos: Set<string>
  },
): SectionMatchSummary {
  const { statedTotal, statedCurrent, lines, systemInvoices, previouslyMatchedDocNos } = args
  const outcomes: MatchOutcome[] = []
  const virtualLines: VirtualLine[] = []
  const usedInvoiceIds = new Set<string>()
  const matchedDocIds = new Set<string>()

  if (ctx.kind === 'DETAIL') {
    // 共通：PAYMENT/BF → NOT_APPLICABLE；CHARGE → NEEDS_MANUAL（三型同）
    for (const l of lines) {
      if (l.lineType === 'PAYMENT' || l.lineType === 'BF') outcomes.push(notApplicable(l.id))
      else if (l.lineType === 'CHARGE') outcomes.push(needsManual(l.id))
    }
    // docNo 分組（冇單號嘅 INVOICE/CREDIT 行 → NEEDS_MANUAL）
    const groups = new Map<string, StatementLineRow[]>()
    for (const l of lines) {
      if (l.lineType !== 'INVOICE' && l.lineType !== 'CREDIT') continue
      if (!l.docNo) {
        outcomes.push(needsManual(l.id))
        continue
      }
      const arr = groups.get(l.docNo) ?? []
      arr.push(l)
      groups.set(l.docNo, arr)
    }
    for (const [docNo, groupLines] of groups) {
      const cands = systemInvoices.filter((s) => s.docNo === docNo)
      if (cands.length > 1) {
        for (const sline of groupLines) outcomes.push(needsManual(sline.id, 'DOC_NO'))
        continue
      }
      if (cands.length === 1) {
        usedInvoiceIds.add(cands[0].id)
        matchedDocIds.add(cands[0].id)
        const { outcomes: o, virtual } = matchDetailGroup(groupLines, cands[0])
        outcomes.push(...o)
        virtualLines.push(...virtual)
      } else {
        for (const sline of groupLines) outcomes.push(missing(sline.id))
      }
    }
  } else {
    // A（INVOICE_LIST）／C（OUTSTANDING：CURRENT 照 A；其他先查 PREVIOUSLY_MATCHED 再照 A）
    for (const line of lines) {
      if (line.lineType === 'PAYMENT' || line.lineType === 'BF') {
        outcomes.push(notApplicable(line.id))
        continue
      }
      if (line.lineType === 'CHARGE') {
        outcomes.push(needsManual(line.id))
        continue
      }
      // C：非 CURRENT（agingBucket 或者 date 唔喺 statementMonth）
      const isCurrent =
        ctx.kind !== 'OUTSTANDING' || line.agingBucket === 'CURRENT' || (line.date !== null && inMonth(line.date, ctx.statementMonth))
      if (!isCurrent) {
        // 之前已確認分段 MATCHED 過同一單號 → PREVIOUSLY_MATCHED（灰「之前已對・未付」）
        if (line.docNo && previouslyMatchedDocNos.has(line.docNo)) {
          outcomes.push({
            lineId: line.id,
            result: 'PREVIOUSLY_MATCHED',
            matchBasis: 'DOC_NO',
            matchedDocumentId: null,
            matchedLineId: null,
            systemAmount: null,
          })
          continue
        }
      }
      const out = matchInvoiceListLine(line, systemInvoices, { docNoSameAsInvoice: ctx.docNoSameAsInvoice }, usedInvoiceIds)
      if (out.matchedDocumentId) matchedDocIds.add(out.matchedDocumentId)
      outcomes.push(out)
    }
  }

  // systemTotal = MATCHED/*_DIFF 行對到嘅系統金額
  const systemTotal = Math.round(outcomes.reduce((sum, o) => sum + (o.systemAmount ?? 0), 0) * 100) / 100

  // 分段 OK（§8.2）：冇 *_DIFF/MISSING/NEEDS_MANUAL 而且 stated = systemTotal
  const hasProblem = outcomes.some(
    (o) => o.result.endsWith('_DIFF') || o.result === 'MISSING_IN_SYSTEM' || o.result === 'NEEDS_MANUAL',
  )
  const statedForCheck = ctx.kind === 'OUTSTANDING' ? statedCurrent : statedTotal
  const ok = !hasProblem && statedForCheck !== null && eq(statedForCheck, systemTotal)

  // 反向（月結單冇）：系統 invoice docDate 喺 statementMonth 但冇被任何行配對
  const notOnStatement: NotOnStatement[] = systemInvoices
    .filter((s) => s.docDate !== null && inMonth(s.docDate, ctx.statementMonth) && !matchedDocIds.has(s.id))
    .map((s) => ({ docId: s.id, docNo: s.docNo, docDate: s.docDate!.toISOString().slice(0, 10), total: s.total }))

  return { outcomes, systemTotal, ok, statedForCheck, virtualLines, notOnStatement }
}
