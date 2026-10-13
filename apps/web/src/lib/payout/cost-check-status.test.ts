// ★ cwm-paycostcheck-20261014：月結預覽成本核對標示 —— 同成本錄入一樣嘅綠色規則
//   跑法: TZ=UTC npx tsx --test src/lib/payout/cost-check-status.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickCostCheck, summarizeChecks } from './cost-check-status'

const st = (state: 'OK' | 'CHANGED' | 'MISSING') => ({ state, docId: 'd', sectionId: 's', confirmedFinalCost: null })
const inv = [{ id: 'i1', docNo: 'INV-1' }]

test('綠：月結 OK 或者有 invoice；月結 CHANGED／MISSING 但有 invoice 都綠（同成本錄入一樣）', () => {
  assert.equal(pickCostCheck(st('OK'), []).green, true)
  assert.equal(pickCostCheck(null, inv).green, true)
  assert.equal(pickCostCheck(st('MISSING'), inv).green, true)
  assert.equal(pickCostCheck(st('CHANGED'), []).green, false)
  assert.equal(pickCostCheck(st('MISSING'), []).green, false)
  assert.equal(pickCostCheck(null, []).green, false)
})

test('統計：綠／月結有出入（黃）／未核對', () => {
  const rows = [
    { check: pickCostCheck(st('OK'), []) },
    { check: pickCostCheck(null, inv) },
    { check: pickCostCheck(st('MISSING'), []) },
    { check: pickCostCheck(st('CHANGED'), []) },
    { check: pickCostCheck(null, []) },
    {},
  ]
  assert.deepEqual(summarizeChecks(rows), { green: 2, warn: 2, none: 2 })
})
