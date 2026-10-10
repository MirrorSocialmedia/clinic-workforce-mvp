/**
 * cwm-labdoc P3 — §8.2 statement-match 單元測試（三型 + 反向 + 共通 + 正規化，逐 case）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  matchSection,
  normDescription,
  normTooth,
  type StatementLineRow,
  type SystemInvoice,
  type SystemLine,
  type SectionCtx,
} from './statement-match'

// ------------------------------------------------------------------
// fixtures
// ------------------------------------------------------------------

const MONTH = '2026-09'
const D = (s: string) => new Date(`${s}T00:00:00Z`)

let lineSeq = 0
function sline(over: Partial<StatementLineRow> = {}): StatementLineRow {
  lineSeq += 1
  return {
    id: `sline-${lineSeq}`,
    lineIndex: lineSeq,
    lineType: 'INVOICE',
    docNo: null,
    date: D('2026-09-15'),
    patientCode: null,
    description: null,
    toothRaw: null,
    qty: null,
    unitPrice: null,
    amount: 100,
    agingBucket: null,
    ...over,
  }
}

let sysSeq = 0
function sysline(over: Partial<SystemLine> = {}): SystemLine {
  sysSeq += 1
  return {
    id: `sysline-${sysSeq}`,
    description: '全鋯',
    toothRaw: null,
    qty: null,
    unitPrice: null,
    amount: 100,
    patientCode: null,
    ...over,
  }
}

function sinv(over: Partial<SystemInvoice> = {}): SystemInvoice {
  sysSeq += 1
  return {
    id: `sinv-${sysSeq}`,
    docNo: null,
    docDate: D('2026-09-15'),
    total: null,
    lines: [],
    ...over,
  }
}

function ctx(over: Partial<SectionCtx> = {}): SectionCtx {
  return { kind: 'INVOICE_LIST', statementMonth: MONTH, docNoSameAsInvoice: true, ...over }
}

function run(ctx: SectionCtx, lines: StatementLineRow[], systemInvoices: SystemInvoice[], extra: Partial<Parameters<typeof matchSection>[1]> = {}) {
  return matchSection(ctx, {
    statedTotal: null,
    statedCurrent: null,
    lines,
    systemInvoices,
    previouslyMatchedDocNos: new Set<string>(),
    ...extra,
  })
}

function outFor(summary: ReturnType<typeof run>, lineId: string) {
  const o = summary.outcomes.find((x) => x.lineId === lineId)
  assert.ok(o, `no outcome for ${lineId}`)
  return o
}

// ------------------------------------------------------------------
// 正規化
// ------------------------------------------------------------------

test('normDescription：細階＋去空格＋全半形＋括號統一', () => {
  assert.equal(normDescription('全鋯（16）'), '全鋯(16)')
  assert.equal(normDescription(' 全 鋯 ( 16 ) '), normDescription('全鋯(16)'))
  assert.equal(normDescription('ＡＢＣ ｄｅｆ'), 'abcdef')
  assert.equal(normDescription(null), '')
})

test('normTooth：字元集合 — 「16 26」＝「26 16」；唔同集合唔等', () => {
  assert.equal(normTooth('16 26'), normTooth('26 16'))
  assert.equal(normTooth('１６'), normTooth('16'))
  assert.notEqual(normTooth('16'), normTooth('162'))
  assert.equal(normTooth(null), '')
})

// ------------------------------------------------------------------
// A. INVOICE_LIST
// ------------------------------------------------------------------

test('A：docNo 相等＋金額同 → MATCHED（DOC_NO），systemAmount = invoice.total', () => {
  const line = sline({ docNo: 'INV-1', amount: 500 })
  const inv = sinv({ docNo: 'INV-1', total: 500 })
  const s = run(ctx(), [line], [inv])
  assert.deepEqual(outFor(s, line.id), {
    lineId: line.id, result: 'MATCHED', matchBasis: 'DOC_NO',
    matchedDocumentId: inv.id, matchedLineId: null, systemAmount: 500,
  })
})

test('A：docNo 相等＋金額唔同 → AMOUNT_DIFF', () => {
  const line = sline({ docNo: 'INV-1', amount: 500 })
  const inv = sinv({ docNo: 'INV-1', total: 480 })
  const s = run(ctx(), [line], [inv])
  assert.equal(outFor(s, line.id).result, 'AMOUNT_DIFF')
  assert.equal(outFor(s, line.id).systemAmount, 480)
})

test('A：docNo 相同多張系統 invoice → NEEDS_MANUAL（唔配對）', () => {
  const line = sline({ docNo: 'INV-1', amount: 500 })
  const a = sinv({ docNo: 'INV-1', total: 500 })
  const b = sinv({ docNo: 'INV-1', total: 500 })
  const s = run(ctx(), [line], [a, b])
  assert.equal(outFor(s, line.id).result, 'NEEDS_MANUAL')
  assert.equal(outFor(s, line.id).matchedDocumentId, null)
})

test('A：docNoSameAsInvoice=false → 唔使 docNo 步，落 fallback', () => {
  const line = sline({ docNo: 'INV-1', amount: 500, date: D('2026-09-15') })
  const inv = sinv({ docNo: 'OTHER', total: 500, docDate: D('2026-09-16') })
  const s = run(ctx({ docNoSameAsInvoice: false }), [line], [inv])
  assert.equal(outFor(s, line.id).result, 'MATCHED')
  assert.equal(outFor(s, line.id).matchBasis, 'FALLBACK')
})

test('A：fallback 日期±3 日唯一＋金額同 → MATCHED（FALLBACK）', () => {
  const line = sline({ amount: 300, date: D('2026-09-15') })
  const inv = sinv({ total: 300, docDate: D('2026-09-18') }) // +3 日
  const s = run(ctx(), [line], [inv])
  assert.equal(outFor(s, line.id).result, 'MATCHED')
  assert.equal(outFor(s, line.id).matchBasis, 'FALLBACK')
})

test('A：fallback 日期差 4 日 → MISSING_IN_SYSTEM', () => {
  const line = sline({ amount: 300, date: D('2026-09-15') })
  const inv = sinv({ total: 300, docDate: D('2026-09-19') }) // +4
  const s = run(ctx(), [line], [inv])
  assert.equal(outFor(s, line.id).result, 'MISSING_IN_SYSTEM')
})

test('A：fallback 多候選＋病人編號唯一 → 配到嗰張', () => {
  const line = sline({ amount: 300, date: D('2026-09-15'), patientCode: 'P-9' })
  const a = sinv({ total: 300, docDate: D('2026-09-15'), lines: [sysline({ patientCode: 'P-8' })] })
  const b = sinv({ total: 300, docDate: D('2026-09-16'), lines: [sysline({ patientCode: 'P-9' })] })
  const s = run(ctx(), [line], [a, b])
  const o = outFor(s, line.id)
  assert.equal(o.result, 'MATCHED')
  assert.equal(o.matchedDocumentId, b.id)
})

test('A：fallback 多候選無病人編號 → NEEDS_MANUAL', () => {
  const line = sline({ amount: 300, date: D('2026-09-15') })
  const a = sinv({ total: 300, docDate: D('2026-09-15') })
  const b = sinv({ total: 300, docDate: D('2026-09-16') })
  const s = run(ctx(), [line], [a, b])
  assert.equal(outFor(s, line.id).result, 'NEEDS_MANUAL')
})

test('A：fallback 金額唔同 → AMOUNT_DIFF（FALLBACK）', () => {
  const line = sline({ amount: 300, date: D('2026-09-15') })
  const inv = sinv({ total: 250, docDate: D('2026-09-15') })
  const s = run(ctx(), [line], [inv])
  const o = outFor(s, line.id)
  assert.equal(o.result, 'AMOUNT_DIFF')
  assert.equal(o.matchBasis, 'FALLBACK')
})

test('A：系統 invoice total=null → NEEDS_MANUAL（配到但比唔到金額）', () => {
  const line = sline({ docNo: 'INV-1', amount: 500 })
  const inv = sinv({ docNo: 'INV-1', total: null })
  const s = run(ctx(), [line], [inv])
  const o = outFor(s, line.id)
  assert.equal(o.result, 'NEEDS_MANUAL')
  assert.equal(o.matchedDocumentId, inv.id)
})

test('A：CREDIT 負數照配對（金額同負數 → MATCHED）', () => {
  const line = sline({ lineType: 'CREDIT', docNo: 'CR-1', amount: -200 })
  const inv = sinv({ docNo: 'CR-1', total: -200 })
  const s = run(ctx(), [line], [inv])
  assert.equal(outFor(s, line.id).result, 'MATCHED')
  assert.equal(outFor(s, line.id).systemAmount, -200)
})

test('A：兩行配同一 invoice → 第二行唔再食（usedInvoiceIds）', () => {
  const l1 = sline({ docNo: 'INV-1', amount: 500 })
  const l2 = sline({ docNo: 'INV-1', amount: 500 })
  const inv = sinv({ docNo: 'INV-1', total: 500 })
  const s = run(ctx(), [l1, l2], [inv])
  assert.equal(outFor(s, l1.id).result, 'MATCHED')
  // l2：docNo 候選已被食 → fallback 無其他 → MISSING
  assert.equal(outFor(s, l2.id).result, 'MISSING_IN_SYSTEM')
})

// ------------------------------------------------------------------
// 共通（PAYMENT/BF/CHARGE）
// ------------------------------------------------------------------

test('共通：PAYMENT/BF → NOT_APPLICABLE（唔計 systemTotal）', () => {
  const pay = sline({ lineType: 'PAYMENT', amount: -5000, docNo: 'PAY-1' })
  const bf = sline({ lineType: 'BF', amount: -100, docNo: 'BF-1' })
  const inv = sinv({ docNo: 'INV-1', total: 100 })
  const good = sline({ docNo: 'INV-1', amount: 100 })
  const s = run(ctx(), [pay, bf, good], [inv])
  assert.equal(outFor(s, pay.id).result, 'NOT_APPLICABLE')
  assert.equal(outFor(s, bf.id).result, 'NOT_APPLICABLE')
  assert.equal(s.systemTotal, 100)
})

test('共通：CHARGE → NEEDS_MANUAL', () => {
  const ch = sline({ lineType: 'CHARGE', amount: 50 })
  const s = run(ctx(), [ch], [])
  assert.equal(outFor(s, ch.id).result, 'NEEDS_MANUAL')
})

// ------------------------------------------------------------------
// B. DETAIL
// ------------------------------------------------------------------

const DETAIL_CTX = ctx({ kind: 'DETAIL' })

test('B：description+tooth 全中 → MATCHED（對到系統行）', () => {
  const line = sline({ docNo: 'INV-9', description: '全鋯 (16)', toothRaw: '16', qty: 1, unitPrice: 1800, amount: 1800 })
  const inv = sinv({
    docNo: 'INV-9',
    total: 1800,
    lines: [sysline({ description: '全鋯（16）', toothRaw: '16', qty: 1, unitPrice: 1800, amount: 1800 })],
  })
  const s = run(DETAIL_CTX, [line], [inv])
  const o = outFor(s, line.id)
  assert.equal(o.result, 'MATCHED')
  assert.ok(o.matchedLineId)
  assert.equal(o.systemAmount, 1800)
})

test('B：分級 DIFF — qty 先（QTY_DIFF 唔係 AMOUNT_DIFF）', () => {
  const line = sline({ docNo: 'INV-9', description: '全鋯', qty: 2, unitPrice: 100, amount: 200 })
  const inv = sinv({ docNo: 'INV-9', total: 200, lines: [sysline({ description: '全鋯', qty: 1, unitPrice: 100, amount: 100 })] })
  assert.equal(outFor(run(DETAIL_CTX, [line], [inv]), line.id).result, 'QTY_DIFF')
})

test('B：分級 DIFF — qty 同、unitPrice 唔同 → PRICE_DIFF', () => {
  const line = sline({ docNo: 'INV-9', description: '全鋯', qty: 2, unitPrice: 110, amount: 220 })
  const inv = sinv({ docNo: 'INV-9', total: 220, lines: [sysline({ description: '全鋯', qty: 2, unitPrice: 100, amount: 200 })] })
  assert.equal(outFor(run(DETAIL_CTX, [line], [inv]), line.id).result, 'PRICE_DIFF')
})

test('B：分級 DIFF — 只 amount 唔同 → AMOUNT_DIFF', () => {
  const line = sline({ docNo: 'INV-9', description: '全鋯', qty: 2, unitPrice: 100, amount: 190 })
  const inv = sinv({ docNo: 'INV-9', total: 190, lines: [sysline({ description: '全鋯', qty: 2, unitPrice: 100, amount: 200 })] })
  assert.equal(outFor(run(DETAIL_CTX, [line], [inv]), line.id).result, 'AMOUNT_DIFF')
})

test('B：缺值維度唔算 DIFF（单边 qty=null → 落 amount 比）', () => {
  const line = sline({ docNo: 'INV-9', description: '全鋯', qty: null, unitPrice: null, amount: 200 })
  const inv = sinv({ docNo: 'INV-9', total: 200, lines: [sysline({ description: '全鋯', qty: 1, unitPrice: 200, amount: 200 })] })
  assert.equal(outFor(run(DETAIL_CTX, [line], [inv]), line.id).result, 'MATCHED')
})

test('B：tooth 字元集合相等（「16 26」vs「26 16」）→ score 0 配對', () => {
  const line = sline({ docNo: 'INV-9', description: '瓷貼面', toothRaw: '16 26', amount: 100 })
  const inv = sinv({ docNo: 'INV-9', total: 100, lines: [sysline({ description: '瓷貼面', toothRaw: '26 16', amount: 100 })] })
  assert.equal(outFor(run(DETAIL_CTX, [line], [inv]), line.id).result, 'MATCHED')
})

test('B：只 description 中（score 1）→ 配對', () => {
  const line = sline({ docNo: 'INV-9', description: '全鋯', amount: 100 })
  const inv = sinv({ docNo: 'INV-9', total: 100, lines: [sysline({ description: '全鋯', toothRaw: '16', amount: 100 })] })
  assert.equal(outFor(run(DETAIL_CTX, [line], [inv]), line.id).result, 'MATCHED')
})

test('B：次序兜底（score 2）— 都唔中 text 就按次序配', () => {
  const l1 = sline({ docNo: 'INV-9', description: '甲', amount: 100 })
  const l2 = sline({ docNo: 'INV-9', description: '乙', amount: 200 })
  const inv = sinv({
    docNo: 'INV-9',
    total: 300,
    lines: [sysline({ description: 'X', amount: 100 }), sysline({ description: 'Y', amount: 200 })],
  })
  const s = run(DETAIL_CTX, [l1, l2], [inv])
  assert.equal(outFor(s, l1.id).result, 'MATCHED')
  assert.equal(outFor(s, l1.id).systemAmount, 100)
  assert.equal(outFor(s, l2.id).result, 'MATCHED')
  assert.equal(outFor(s, l2.id).systemAmount, 200)
})

test('B：statement 行系統冇 → MISSING_IN_SYSTEM（matchedDocumentId 有）— 2 行 vs 1 行，餘下冇對手', () => {
  const hit = sline({ docNo: 'INV-9', description: '存在', amount: 100 })
  const ghost = sline({ docNo: 'INV-9', description: '唔存在', amount: 99 })
  const inv = sinv({ docNo: 'INV-9', total: 100, lines: [sysline({ description: '存在', amount: 100 })] })
  const s = run(DETAIL_CTX, [hit, ghost], [inv])
  assert.equal(outFor(s, hit.id).result, 'MATCHED')
  const o = outFor(s, ghost.id)
  assert.equal(o.result, 'MISSING_IN_SYSTEM')
  assert.equal(o.matchedDocumentId, inv.id)
})

test('B：系統有、月結單冇 → virtualLines（唔建表）', () => {
  const line = sline({ docNo: 'INV-9', description: '存在', amount: 100 })
  const inv = sinv({
    docNo: 'INV-9',
    total: 300,
    lines: [sysline({ description: '存在', amount: 100 }), sysline({ description: '額外行', amount: 200 })],
  })
  const s = run(DETAIL_CTX, [line], [inv])
  assert.equal(s.virtualLines.length, 1)
  assert.equal(s.virtualLines[0].description, '額外行')
  assert.equal(s.virtualLines[0].amount, 200)
  assert.equal(s.virtualLines[0].systemLineId, inv.lines[1].id)
})

test('B：整組 docNo 系統冇 → 全組 MISSING_IN_SYSTEM', () => {
  const l1 = sline({ docNo: 'INV-X', description: 'a', amount: 1 })
  const l2 = sline({ docNo: 'INV-X', description: 'b', amount: 2 })
  const s = run(DETAIL_CTX, [l1, l2], [])
  assert.equal(outFor(s, l1.id).result, 'MISSING_IN_SYSTEM')
  assert.equal(outFor(s, l2.id).result, 'MISSING_IN_SYSTEM')
})

test('B：同一 docNo 多張系統 invoice → NEEDS_MANUAL', () => {
  const line = sline({ docNo: 'INV-9', description: 'a', amount: 100 })
  const a = sinv({ docNo: 'INV-9', total: 100, lines: [sysline({ description: 'a', amount: 100 })] })
  const b = sinv({ docNo: 'INV-9', total: 100, lines: [sysline({ description: 'a', amount: 100 })] })
  const s = run(DETAIL_CTX, [line], [a, b])
  assert.equal(outFor(s, line.id).result, 'NEEDS_MANUAL')
})

test('B：冇單號嘅 INVOICE 行 → NEEDS_MANUAL；PAYMENT → NOT_APPLICABLE；CHARGE → NEEDS_MANUAL', () => {
  const noDoc = sline({ docNo: null, description: 'a', amount: 10 })
  const pay = sline({ lineType: 'PAYMENT', docNo: 'P1', amount: -5 })
  const chg = sline({ lineType: 'CHARGE', docNo: 'C1', amount: 3 })
  const s = run(DETAIL_CTX, [noDoc, pay, chg], [])
  assert.equal(outFor(s, noDoc.id).result, 'NEEDS_MANUAL')
  assert.equal(outFor(s, pay.id).result, 'NOT_APPLICABLE')
  assert.equal(outFor(s, chg.id).result, 'NEEDS_MANUAL')
})

// ------------------------------------------------------------------
// C. OUTSTANDING
// ------------------------------------------------------------------

const OUT_CTX = ctx({ kind: 'OUTSTANDING' })

test('C：CURRENT 行照 A 配對', () => {
  const line = sline({ docNo: 'INV-1', amount: 500, agingBucket: 'CURRENT' })
  const inv = sinv({ docNo: 'INV-1', total: 500 })
  const s = run(OUT_CTX, [line], [inv], { statedCurrent: 500 })
  assert.equal(outFor(s, line.id).result, 'MATCHED')
  assert.equal(s.ok, true)
})

test('C：CURRENT 判定 fallback — agingBucket 冇但 date 喺 statementMonth', () => {
  const line = sline({ docNo: 'INV-1', amount: 500, agingBucket: null, date: D('2026-09-20') })
  const inv = sinv({ docNo: 'INV-1', total: 500 })
  const s = run(OUT_CTX, [line], [inv])
  assert.equal(outFor(s, line.id).result, 'MATCHED')
})

test('C：非 CURRENT＋之前已確認分段 MATCHED 過同單號 → PREVIOUSLY_MATCHED（唔計 systemTotal）', () => {
  // 非 CURRENT = bucket 唔係 CURRENT 而且 date 唔喺 statementMonth（spec C.1）
  const line = sline({ docNo: 'INV-OLD', amount: 300, agingBucket: 'D31_90', date: D('2026-08-15') })
  const inv = sinv({ docNo: 'INV-OLD', total: 300, docDate: D('2026-08-15') })
  const s = run(OUT_CTX, [line], [inv], { previouslyMatchedDocNos: new Set(['INV-OLD']) })
  const o = outFor(s, line.id)
  assert.equal(o.result, 'PREVIOUSLY_MATCHED')
  assert.equal(o.systemAmount, null)
  // PREVIOUSLY_MATCHED 唔計入 systemTotal；亦唔算反向 notOnStatement（佢 match 咗舊單）
  assert.equal(s.systemTotal, 0)
})

test('C：非 CURRENT＋冇 MATCHED 過＋系統冇 → MISSING_IN_SYSTEM', () => {
  const line = sline({ docNo: 'INV-OLD', amount: 300, agingBucket: 'D91_365', date: D('2026-07-01') })
  const s = run(OUT_CTX, [line], [], { previouslyMatchedDocNos: new Set<string>() })
  assert.equal(outFor(s, line.id).result, 'MISSING_IN_SYSTEM')
})

test('C：非 CURRENT＋冇 MATCHED 過＋系統有 → 照 A（MATCHED）', () => {
  const line = sline({ docNo: 'INV-2', amount: 200, agingBucket: 'D31_90', date: D('2026-08-20') })
  const inv = sinv({ docNo: 'INV-2', total: 200, docDate: D('2026-08-20') })
  const s = run(OUT_CTX, [line], [inv], { statedCurrent: 200 })
  assert.equal(outFor(s, line.id).result, 'MATCHED')
})

test('C：OK 用 statedCurrent vs Σ（PREVIOUSLY_MATCHED 唔計入）', () => {
  const cur = sline({ docNo: 'INV-1', amount: 500, agingBucket: 'CURRENT' })
  const old = sline({ docNo: 'INV-OLD', amount: 300, agingBucket: 'D31_90', date: D('2026-08-15') })
  const inv = sinv({ docNo: 'INV-1', total: 500 })
  const s = run(OUT_CTX, [cur, old], [inv], { statedCurrent: 500, previouslyMatchedDocNos: new Set(['INV-OLD']) })
  assert.equal(outFor(s, old.id).result, 'PREVIOUSLY_MATCHED')
  assert.equal(s.systemTotal, 500)
  assert.equal(s.ok, true)
})

// ------------------------------------------------------------------
// systemTotal / OK
// ------------------------------------------------------------------

test('systemTotal：只計 MATCHED/*_DIFF 行（NEEDS_MANUAL/MISSING/NOT_APPLICABLE 唔計）', () => {
  const good = sline({ docNo: 'A', amount: 100 })
  const diff = sline({ docNo: 'B', amount: 200 })
  const man = sline({ lineType: 'CHARGE', amount: 1 })
  const sys = [sinv({ docNo: 'A', total: 100 }), sinv({ docNo: 'B', total: 180 })]
  const s = run(ctx(), [good, diff, man], sys)
  assert.equal(outFor(s, good.id).result, 'MATCHED')
  assert.equal(outFor(s, diff.id).result, 'AMOUNT_DIFF')
  assert.equal(s.systemTotal, 280)
  assert.equal(s.ok, false) // 有 AMOUNT_DIFF
})

test('OK：全 MATCHED＋statedTotal=systemTotal', () => {
  const l1 = sline({ docNo: 'A', amount: 100 })
  const l2 = sline({ docNo: 'B', amount: 200 })
  const sys = [sinv({ docNo: 'A', total: 100 }), sinv({ docNo: 'B', total: 200 })]
  const s = run(ctx(), [l1, l2], sys, { statedTotal: 300 })
  assert.equal(s.ok, true)
  assert.equal(s.statedForCheck, 300)
})

test('OK：全 MATCHED 但 statedTotal≠systemTotal → 唔 OK', () => {
  const l1 = sline({ docNo: 'A', amount: 100 })
  const sys = [sinv({ docNo: 'A', total: 100 })]
  const s = run(ctx(), [l1], sys, { statedTotal: 300 })
  assert.equal(s.ok, false)
})

test('OK：statedTotal=null → 唔 OK（比唔到）', () => {
  const l1 = sline({ docNo: 'A', amount: 100 })
  const sys = [sinv({ docNo: 'A', total: 100 })]
  const s = run(ctx(), [l1], sys)
  assert.equal(s.ok, false)
})

// ------------------------------------------------------------------
// 反向（月結單冇）
// ------------------------------------------------------------------

test('反向：系統 invoice 喺 statementMonth 但未配對 → notOnStatement', () => {
  const line = sline({ docNo: 'A', amount: 100 })
  const matched = sinv({ docNo: 'A', total: 100, docDate: D('2026-09-10') })
  const rogue = sinv({ docNo: 'R', total: 77, docDate: D('2026-09-20') })
  const s = run(ctx(), [line], [matched, rogue])
  assert.equal(s.notOnStatement.length, 1)
  assert.equal(s.notOnStatement[0].docId, rogue.id)
  assert.equal(s.notOnStatement[0].docDate, '2026-09-20')
  assert.equal(s.notOnStatement[0].total, 77)
})

test('反向：已配對 invoice 唔入 notOnStatement', () => {
  const line = sline({ docNo: 'A', amount: 100 })
  const matched = sinv({ docNo: 'A', total: 100, docDate: D('2026-09-10') })
  const s = run(ctx(), [line], [matched])
  assert.equal(s.notOnStatement.length, 0)
})

test('反向：docDate 唔喺 statementMonth 嘅未配對 invoice 唔入（范围外）', () => {
  const line = sline({ docNo: 'A', amount: 100 })
  const matched = sinv({ docNo: 'A', total: 100, docDate: D('2026-09-10') })
  const old = sinv({ docNo: 'X', total: 55, docDate: D('2026-07-15') })
  const s = run(ctx(), [line], [matched, old])
  assert.equal(s.notOnStatement.length, 0)
})

test('反向：DETAIL 配到整張 invoice → 唔入 notOnStatement（行級缺席去 virtualLines）', () => {
  const line = sline({ docNo: 'INV-9', description: '存在', amount: 100 })
  const inv = sinv({ docNo: 'INV-9', total: 300, docDate: D('2026-09-05'), lines: [sysline({ description: '存在', amount: 100 }), sysline({ description: '額外', amount: 200 })] })
  const s = run(DETAIL_CTX, [line], [inv])
  assert.equal(s.notOnStatement.length, 0)
  assert.equal(s.virtualLines.length, 1)
})
