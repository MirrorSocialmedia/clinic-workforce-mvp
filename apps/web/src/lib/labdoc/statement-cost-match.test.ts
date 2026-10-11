/**
 * 月結單 ⇄ 成本錄入 對數（純函數）
 * 用 2026-10-11 生產個案數字：HC 2026-09 土瓜灣 Dr. Tong — 6 行加埋 $5,670 ＝ 一筆成本 $5,670。
 */
import assert from 'node:assert'
import { test } from 'node:test'
import { matchStatementToCosts, deriveQty, type CostLineIn, type CostCaseIn } from './statement-cost-match'

const L = (i: number, amount: number, over: Partial<CostLineIn> = {}): CostLineIn => ({
  id: `l${i}`, lineIndex: i, lineType: 'INVOICE', amount, qty: null, unitPrice: null, date: null, agingBucket: null, resolution: null, ...over,
})
const C = (id: string, finalCost: number | null, over: Partial<CostCaseIn> = {}): CostCaseIn => ({
  id, patientCode: null, itemType: 'Implant', finalCost, status: 'PRICED', receivedAt: new Date('2026-09-29T00:00:00Z'), ...over,
})
const base = { outstanding: false, statementMonth: '2026-09', statedTotal: null }

test('生產個案：6 行（含兩行 $0）＝ 一筆成本 → OK，連續行劃埋', () => {
  const lines = [L(0, 0), L(1, 1120), L(2, 1680), L(3, 1640), L(4, 1230), L(5, 0)]
  const r = matchStatementToCosts({ ...base, lines, costs: [C('c1', 5670)] })
  assert.equal(r.status, 'OK')
  assert.equal(r.statementTotal, 5670)
  assert.equal(r.costTotal, 5670)
  assert.deepEqual(r.pairs, [{ costCaseId: 'c1', lineIds: ['l1', 'l2', 'l3', 'l4'] }])
  assert.equal(r.lines.find((x) => x.id === 'l0')!.result, 'NOT_APPLICABLE')
  assert.equal(r.lines.find((x) => x.id === 'l2')!.result, 'MATCHED')
  assert.deepEqual(r.unpairedCostIds, [])
})

test('一行對一筆優先；剩低兩邊列出；總數唔同 → DIFF', () => {
  const lines = [L(0, 1100), L(1, 560), L(2, 400)]
  const r = matchStatementToCosts({ ...base, lines, costs: [C('a', 1100), C('b', 300)] })
  assert.equal(r.status, 'DIFF')
  assert.equal(r.diff, 2060 - 1400)
  assert.deepEqual(r.pairs, [{ costCaseId: 'a', lineIds: ['l0'] }])
  assert.equal(r.lines.find((x) => x.id === 'l1')!.result, 'UNPAIRED')
  assert.deepEqual(r.unpairedCostIds, ['b'])
})

test('總數一致但配對唔到（金額拆法唔同）→ 仍然 OK', () => {
  const lines = [L(0, 100), L(1, 200)]
  const r = matchStatementToCosts({ ...base, lines, costs: [C('a', 150), C('b', 150)] })
  assert.equal(r.status, 'OK')
  assert.equal(r.pairs.length, 0)
})

test('備貨／唔關我哋事唔計入總數', () => {
  const lines = [L(0, 1000), L(1, 300, { resolution: 'STOCK' }), L(2, 50, { resolution: 'NOT_OURS' })]
  const r = matchStatementToCosts({ ...base, lines, costs: [C('a', 1000)] })
  assert.equal(r.status, 'OK')
  assert.equal(r.statementTotal, 1000)
  assert.equal(r.stockTotal, 300)
  assert.equal(r.notOursTotal, 50)
  assert.equal(r.lines.find((x) => x.id === 'l1')!.result, 'NOT_APPLICABLE')
})

test('成段備貨、冇成本 → 0 = 0 OK', () => {
  const lines = [L(0, 300, { resolution: 'STOCK' }), L(1, 200, { resolution: 'STOCK' })]
  const r = matchStatementToCosts({ ...base, lines, costs: [] })
  assert.equal(r.status, 'OK')
  assert.equal(r.statementTotal, 0)
})

test('PAYMENT／BF 唔計；CREDIT 負數照計', () => {
  const lines = [L(0, 500), L(1, -100, { lineType: 'CREDIT' }), L(2, -999, { lineType: 'PAYMENT' }), L(3, 888, { lineType: 'BF' })]
  const r = matchStatementToCosts({ ...base, lines, costs: [C('a', 400)] })
  assert.equal(r.statementTotal, 400)
  assert.equal(r.status, 'OK')
  assert.equal(r.lines.find((x) => x.id === 'l2')!.result, 'NOT_APPLICABLE')
})

test('欠款型只計本月（CURRENT）', () => {
  const lines = [L(0, 500, { agingBucket: 'CURRENT' }), L(1, 700, { agingBucket: 'D31_90' })]
  const r = matchStatementToCosts({ ...base, outstanding: true, lines, costs: [C('a', 500)] })
  assert.equal(r.statementTotal, 500)
  assert.equal(r.status, 'OK')
})

test('未有價成本當 0 計並數埋', () => {
  const r = matchStatementToCosts({ ...base, lines: [L(0, 560)], costs: [C('a', null, { status: 'PENDING' }), C('b', 560, { status: 'PENDING' })] })
  assert.equal(r.costTotal, 560)
  assert.equal(r.unpricedCount, 2)
  assert.equal(r.status, 'OK')
})

test('讀數檢查：印咗嘅總數 vs 行加埋', () => {
  const r = matchStatementToCosts({ ...base, statedTotal: 1500, lines: [L(0, 1000), L(1, 300, { resolution: 'STOCK' })], costs: [C('a', 1000)] })
  assert.deepEqual(r.readCheck, { stated: 1500, linesSum: 1300, ok: false })
})

test('deriveQty：金額 ÷ 單價', () => {
  assert.equal(deriveQty(null, 560, 1120), 2)
  assert.equal(deriveQty(null, 410, 1230), 3)
  assert.equal(deriveQty(null, 0, 0), null)
  assert.equal(deriveQty(null, 300, 500), null)
  assert.equal(deriveQty(4, 300, 500), 4)
})
