// ★ 2026-10-13：月結單人手改行／加行 — 輸入驗證＋行鎖
//   跑法: TZ=UTC npx tsx --test src/lib/labdoc/statement-line-edit.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLineInput, lineEditBlock } from './statement-line-edit'

const ok = (r: ReturnType<typeof parseLineInput>) => { assert.ok(!('error' in r), JSON.stringify(r)); return r as Exclude<typeof r, { error: string }> }
const bad = (r: ReturnType<typeof parseLineInput>) => assert.ok('error' in r, JSON.stringify(r))

test('金額：加行必填；接受 "HK$4,000.00"、負數（貸項）；拒絕非數字、太大、3 個小數位', () => {
  bad(parseLineInput({}, { requireAmount: true }))
  bad(parseLineInput({ amount: '' }, { requireAmount: true }))
  assert.equal(ok(parseLineInput({ amount: 'HK$4,000.00' }, { requireAmount: true })).input.amount, 4000)
  assert.equal(ok(parseLineInput({ amount: -40 }, { requireAmount: true })).input.amount, -40)
  assert.equal(ok(parseLineInput({ amount: 0.1 + 0.2 }, { requireAmount: true })).input.amount, 0.3)
  for (const a of ['abc', 1e9, 1.234, NaN, Infinity, null, true]) bad(parseLineInput({ amount: a }, { requireAmount: true }))
})

test('改行：冇傳金額 → 唔改金額；欄位 trim、空字串 = 清空、太長拒絕', () => {
  const r = ok(parseLineInput({ description: '  種植  ', docNo: '', patientCode: null }, { requireAmount: false }))
  assert.equal(r.input.amount, undefined)
  assert.equal(r.input.description, '種植')
  assert.equal(r.input.docNoRaw, null)
  assert.equal(r.input.patientCode, null)
  bad(parseLineInput({ description: 'x'.repeat(201) }, { requireAmount: false }))
  bad(parseLineInput({ docNo: 123 }, { requireAmount: false }))
  bad(parseLineInput({ note: 'x'.repeat(201) }, { requireAmount: false }))
})

test('日期：YYYY-MM-DD 而且要存在', () => {
  assert.equal(ok(parseLineInput({ date: '2026-09-25' }, { requireAmount: false })).input.date?.toISOString().slice(0, 10), '2026-09-25')
  assert.equal(ok(parseLineInput({ date: '' }, { requireAmount: false })).input.date, null)
  for (const d of ['2026-02-30', '2026-13-01', '25/09/2026', '2026-9-5']) bad(parseLineInput({ date: d }, { requireAmount: false }))
})

test('行鎖：結轉副本／計入下個月／以月結單為準 → 唔准改；人手配對只擋改金額同刪；AI 行唔准刪', () => {
  const base = { carriedFromLineId: null, resolution: null, pairMode: null, manualSource: null }
  assert.equal(lineEditBlock(base, { amountChanging: true }), null)
  assert.ok(lineEditBlock({ ...base, carriedFromLineId: 'x' }, { amountChanging: false }))
  assert.ok(lineEditBlock({ ...base, resolution: 'NEXT_MONTH' }, { amountChanging: false }))
  assert.ok(lineEditBlock({ ...base, resolution: 'STATEMENT_WINS' }, { amountChanging: false }))
  assert.equal(lineEditBlock({ ...base, resolution: 'STOCK' }, { amountChanging: true }), null)
  assert.ok(lineEditBlock({ ...base, pairMode: 'MANUAL' }, { amountChanging: true }))
  assert.equal(lineEditBlock({ ...base, pairMode: 'MANUAL' }, { amountChanging: false }), null)
  assert.ok(lineEditBlock(base, { amountChanging: false, deleting: true }), 'AI 行唔准刪')
  assert.ok(lineEditBlock({ ...base, manualSource: 'EDITED' }, { amountChanging: false, deleting: true }), '改過嘅 AI 行都唔准刪')
  assert.equal(lineEditBlock({ ...base, manualSource: 'ADDED' }, { amountChanging: false, deleting: true }), null)
  assert.ok(lineEditBlock({ ...base, manualSource: 'ADDED', pairMode: 'MANUAL' }, { amountChanging: false, deleting: true }))
})
