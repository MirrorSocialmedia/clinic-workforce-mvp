import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCostRows, shiftMonth, type CostRow } from './cost-detail'

const row = (o: Partial<CostRow>): CostRow => ({
  id: Math.random().toString(36).slice(2), category: 'LAB', orderedAt: '2026-09-03', receivedAt: null, patientCode: 'MF000001',
  vendor: 'Modern', item: 'Crown', amount: null, status: 'PENDING', periodMonth: null, crossMonth: false, redo: false, ...o,
})
// 預覽 2026-09；今日 2026-10-06 → 60 日前 = 2026-08-07
const M = '2026-09', RECENT = '2026-08-07'

test('shiftMonth', () => {
  assert.equal(shiftMonth('2026-09', -1), '2026-08')
  assert.equal(shiftMonth('2026-01', -1), '2025-12')
  assert.equal(shiftMonth('2026-12', 1), '2027-01')
})

test('同 engine 一樣：本月到貨、有價、未作廢先計入', () => {
  const d = classifyCostRows([
    row({ orderedAt: '2026-08-30', receivedAt: '2026-09-02', periodMonth: M, amount: 280, crossMonth: true }),
    row({ orderedAt: '2026-09-03', receivedAt: '2026-09-10', periodMonth: M, amount: 420 }),
    row({ orderedAt: '2026-09-18', receivedAt: '2026-09-25', periodMonth: M, amount: null }), // 未有價錢
    row({ orderedAt: '2026-09-05', receivedAt: '2026-09-12', periodMonth: M, amount: 99, status: 'VOID' }),
  ], M, RECENT)
  assert.equal(d.counted.length, 2)
  assert.equal(d.countedTotal, 700)
  assert.equal(d.unpriced.length, 1)
  assert.equal(d.voided.length, 1)
  assert.equal(d.reminders, 1)
})

test('上月落單、仍未完成：未到貨＋上月到貨未有價錢（標已鎖）', () => {
  const d = classifyCostRows([
    row({ orderedAt: '2026-09-26' }),                                                     // 本月未到貨
    row({ orderedAt: '2026-08-21' }),                                                     // 上月未到貨
    row({ orderedAt: '2026-08-26', receivedAt: '2026-08-29', periodMonth: '2026-08' }),   // 上月到貨、未有價錢（8 月已鎖）
    row({ orderedAt: '2026-07-30', receivedAt: '2026-08-03', periodMonth: '2026-08' }),   // 7 月落單、上月到貨、未有價錢
    row({ orderedAt: '2026-08-28', receivedAt: '2026-08-31', periodMonth: '2026-08', amount: 300 }), // 上月已完成：唔出
    row({ orderedAt: '2026-08-15', receivedAt: '2026-08-20', periodMonth: '2026-08', status: 'VOID' }), // 作廢：唔出
  ], M, RECENT, new Set(['2026-08']))
  assert.equal(d.notReceived.length, 1)
  assert.deepEqual(d.lastMonth.map(r => [r.orderedAt, r.pending, !!r.periodLocked]), [
    ['2026-07-30', 'UNPRICED', true],
    ['2026-08-21', 'NOT_RECEIVED', false],
    ['2026-08-26', 'UNPRICED', true],
  ])
  assert.equal(d.reminders, 4)
})

test('未到貨：更早但 60 日內照出（同成本異常接駁）；超過 60 日唔出', () => {
  const d = classifyCostRows([
    row({ orderedAt: '2026-07-31' }), // 7 月但 < 60 日前？2026-07-31 < 2026-08-07 → 去成本異常
    row({ orderedAt: '2026-08-07' }), // 上月
  ], M, '2026-07-30') // 假設今日 9/28：60 日前 = 7/30
  assert.deepEqual(d.lastMonth.map(r => r.orderedAt), ['2026-07-31', '2026-08-07'])
  const d2 = classifyCostRows([row({ orderedAt: '2026-07-31' })], M, RECENT)
  assert.equal(d2.lastMonth.length, 0)
})

test('植牙跟落單日：冇未到貨；上月落單未有價錢照出', () => {
  const d = classifyCostRows([
    row({ category: 'IMPLANT', orderedAt: '2026-09-04', receivedAt: '2026-09-04', periodMonth: M, amount: null }),
    row({ category: 'IMPLANT', orderedAt: '2026-09-08', receivedAt: '2026-09-08', periodMonth: M, amount: 1500 }),
    row({ category: 'IMPLANT', orderedAt: '2026-08-20', receivedAt: '2026-08-20', periodMonth: '2026-08', amount: null }),
  ], M, RECENT)
  assert.equal(d.unpriced.length, 1)
  assert.equal(d.countedTotal, 1500)
  assert.equal(d.notReceived.length, 0)
  assert.deepEqual(d.lastMonth.map(r => r.pending), ['UNPRICED'])
})
