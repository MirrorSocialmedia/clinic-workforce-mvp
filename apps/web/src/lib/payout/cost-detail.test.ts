import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCostRows, type CostRow } from './cost-detail'

const row = (o: Partial<CostRow>): CostRow => ({
  id: Math.random().toString(36).slice(2), category: 'LAB', orderedAt: '2026-09-03', receivedAt: null, patientCode: 'MF000001',
  vendor: 'Modern', item: 'Crown', amount: null, status: 'PENDING', periodMonth: null, crossMonth: false, redo: false, ...o,
})

test('同 engine 一樣：本月到貨、有價、未作廢先計入', () => {
  const d = classifyCostRows([
    row({ orderedAt: '2026-08-30', receivedAt: '2026-09-02', periodMonth: '2026-09', amount: 280, crossMonth: true }),
    row({ orderedAt: '2026-09-03', receivedAt: '2026-09-10', periodMonth: '2026-09', amount: 420 }),
    row({ orderedAt: '2026-09-18', receivedAt: '2026-09-25', periodMonth: '2026-09', amount: null }), // 未有價錢
    row({ orderedAt: '2026-09-05', receivedAt: '2026-09-12', periodMonth: '2026-09', amount: 99, status: 'VOID' }), // 作廢
  ], '2026-09', '2026-09-01', '2026-08-07')
  assert.equal(d.counted.length, 2)
  assert.equal(d.countedTotal, 700)
  assert.equal(d.counted[0].receivedAt, '2026-09-02')
  assert.equal(d.unpriced.length, 1)
  assert.equal(d.voided.length, 1)
  assert.equal(d.reminders, 1)
})

test('未到貨：本月落單 vs 之前 60 日內 vs 更舊（唔出，去成本異常）', () => {
  const d = classifyCostRows([
    row({ orderedAt: '2026-09-26' }),          // 本月落單、未到貨
    row({ orderedAt: '2026-08-20' }),          // 60 日內
    row({ orderedAt: '2026-07-28' }),          // 超過 60 日 → 唔喺預覽
    row({ orderedAt: '2026-08-30', receivedAt: '2026-10-02', periodMonth: '2026-10', amount: 300 }), // 下月到貨，唔關事
  ], '2026-09', '2026-09-01', '2026-08-07')
  assert.equal(d.notReceived.length, 1)
  assert.equal(d.notReceived[0].orderedAt, '2026-09-26')
  assert.deepEqual(d.recentNotReceived.map(r => r.orderedAt), ['2026-08-20'])
  assert.equal(d.counted.length, 0)
  assert.equal(d.reminders, 2)
})

test('Implant 跟落單日：冇未到貨呢回事，只會有未有價錢', () => {
  const d = classifyCostRows([
    row({ category: 'IMPLANT', orderedAt: '2026-09-04', receivedAt: '2026-09-04', periodMonth: '2026-09', amount: null }),
    row({ category: 'IMPLANT', orderedAt: '2026-09-08', receivedAt: '2026-09-08', periodMonth: '2026-09', amount: 1500 }),
  ], '2026-09', '2026-09-01', '2026-08-07')
  assert.equal(d.unpriced.length, 1)
  assert.equal(d.countedTotal, 1500)
  assert.equal(d.notReceived.length + d.recentNotReceived.length, 0)
})
