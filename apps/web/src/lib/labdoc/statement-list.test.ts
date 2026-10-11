/**
 * 2026-10-11：月結單列表 — 診所／醫生／總數／確認進度由分段計（statement-list.ts）
 * 個案：HC 2026-09 — 兩段（Dr.Tse $12,400 已對數；另一段 $360），單頭 AI 讀咗其中一位醫生＋$360。
 */
import assert from 'node:assert'
import { test } from 'node:test'
import { statementListSummary } from './statement-list'

const YMT = 'y'.repeat(25)
const TKW = 't'.repeat(25)
const TSE = 'p'.repeat(25)
const P2 = 'q'.repeat(25)
const line = (amount: number, over: Record<string, unknown> = {}) => ({ lineType: 'INVOICE', amount, resolution: null, agingBucket: null, ...over })

test('兩段：總數 = 各段加埋（$12,400 + $360）；診所去重；醫生兩位；確認進度', () => {
  const r = statementListSummary([
    { clinicId: YMT, providerId: TSE, status: 'CONFIRMED', resultJson: { mode: 'COST', statementTotal: 12400 } },
    { clinicId: YMT, providerId: P2, status: 'OK', resultJson: { mode: 'COST', statementTotal: 360 } },
  ])
  assert.strictEqual(r.total, 12760)
  assert.deepStrictEqual(r.clinicIds, [YMT])
  assert.deepStrictEqual(r.providerIds, [TSE, P2])
  assert.strictEqual(r.sectionCount, 2)
  assert.strictEqual(r.confirmedCount, 1)
  assert.strictEqual(r.unassignedCount, 0)
})

test('未對數嘅段：行加埋（唔計付款、備貨、唔關我哋事；有分齡欄只計本月）', () => {
  const r = statementListSummary([
    { clinicId: null, providerId: null, status: 'NEEDS_ASSIGN', resultJson: null, lines: [
      line(1000), line(-100, { lineType: 'CREDIT' }), line(500, { lineType: 'PAYMENT' }),
      line(300, { resolution: 'STOCK' }), line(50, { resolution: 'NOT_OURS' }),
    ] },
    { clinicId: TKW, providerId: null, status: 'NEEDS_ASSIGN', resultJson: null, lines: [
      line(200, { agingBucket: 'CURRENT' }), line(999, { agingBucket: 'D31_90' }),
    ] },
  ])
  assert.strictEqual(r.total, 1100)
  assert.strictEqual(r.unassignedCount, 2)
  assert.deepStrictEqual(r.clinicIds, [TKW])
  assert.deepStrictEqual(r.providerIds, [])
})

test('冇段／冇行 → 總數 null', () => {
  assert.strictEqual(statementListSummary([]).total, null)
  assert.strictEqual(statementListSummary([{ clinicId: null, providerId: null, status: 'PENDING', resultJson: null, lines: [] }]).total, null)
})
