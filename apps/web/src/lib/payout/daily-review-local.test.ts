// ★ cwm-pvcheck-20261007 C：applyLocalCheck（就地核對後本地更新，純函數）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyLocalCheck } from './daily-review-local'
import type { DailyReview } from './daily-review'

const base = (days: DailyReview['days']): DailyReview => {
  const counts = {
    checked: days.filter(d => d.status === 'CHECKED').length,
    changed: days.filter(d => d.status === 'CHANGED').length,
    unchecked: days.filter(d => d.status === 'UNCHECKED').length,
  }
  return {
    days,
    doctorTotal: 12345,
    counts,
    needsAck: counts.changed + counts.unchecked > 0,
  }
}

test('applyLocalCheck：UNCHECKED → CHECKED；counts 已核對 +1、未核對 −1', () => {
  const r = base([
    { date: '2026-09-02', doctorRaw: 4000, storeTotal: 7000, status: 'UNCHECKED', nurseName: null, checkedAt: null, checkedAmount: null },
    { date: '2026-09-03', doctorRaw: 3000, storeTotal: 5000, status: 'UNCHECKED', nurseName: null, checkedAt: null, checkedAmount: null },
  ])
  const next = applyLocalCheck(r, '2026-09-02', '陳美玲', '2026-10-07T13:00:00.000Z')
  const d = next.days.find(x => x.date === '2026-09-02')!
  assert.equal(d.status, 'CHECKED')
  assert.equal(d.nurseName, '陳美玲')
  assert.equal(d.checkedAt, '2026-10-07T13:00:00.000Z')
  assert.equal(d.checkedAmount, 7000)
  assert.deepEqual(next.counts, { checked: 1, changed: 0, unchecked: 1 })
  assert.equal(next.needsAck, true)
})

test('applyLocalCheck：CHANGED → CHECKED；counts 有變 −1', () => {
  const r = base([
    { date: '2026-09-05', doctorRaw: 3200, storeTotal: 12840, status: 'CHANGED', nurseName: '陳美玲', checkedAt: '2026-09-05T10:00:00Z', checkedAmount: 12340 },
  ])
  const next = applyLocalCheck(r, '2026-09-05', '陳美玲', '2026-10-07T14:00:00.000Z')
  assert.equal(next.days[0].status, 'CHECKED')
  assert.equal(next.days[0].checkedAmount, 12840) // = 而家 storeTotal
  assert.deepEqual(next.counts, { checked: 1, changed: 0, unchecked: 0 })
})

test('applyLocalCheck：最後一日核對完 → needsAck === false', () => {
  const r = base([
    { date: '2026-09-02', doctorRaw: 100, storeTotal: 100, status: 'CHECKED', nurseName: 'A', checkedAt: '2026-09-02T10:00:00Z', checkedAmount: 100 },
    { date: '2026-09-03', doctorRaw: 200, storeTotal: 200, status: 'UNCHECKED', nurseName: null, checkedAt: null, checkedAmount: null },
  ])
  assert.equal(r.needsAck, true)
  const next = applyLocalCheck(r, '2026-09-03', 'B', '2026-10-07T15:00:00.000Z')
  assert.equal(next.needsAck, false)
  assert.deepEqual(next.counts, { checked: 2, changed: 0, unchecked: 0 })
})

test('applyLocalCheck：搵唔到嗰日 → 原樣返回，唔會 throw', () => {
  const r = base([
    { date: '2026-09-02', doctorRaw: 100, storeTotal: 100, status: 'UNCHECKED', nurseName: null, checkedAt: null, checkedAmount: null },
  ])
  const next = applyLocalCheck(r, '2026-12-31', 'X', '2026-10-07T16:00:00.000Z')
  assert.equal(next, r) // 同一個物件
})

test('applyLocalCheck：唔改原物件（純函數）', () => {
  const r = base([
    { date: '2026-09-02', doctorRaw: 4000, storeTotal: 7000, status: 'UNCHECKED', nurseName: null, checkedAt: null, checkedAmount: null },
    { date: '2026-09-03', doctorRaw: 100, storeTotal: 100, status: 'UNCHECKED', nurseName: null, checkedAt: null, checkedAmount: null },
  ])
  const snapshot = JSON.parse(JSON.stringify(r))
  const next = applyLocalCheck(r, '2026-09-02', '陳美玲', '2026-10-07T13:00:00.000Z')
  assert.notEqual(next, r)
  assert.notEqual(next.days, r.days)
  assert.notEqual(next.days[0], r.days[0])
  assert.deepEqual(r, snapshot) // 原 input 完全不變
})
