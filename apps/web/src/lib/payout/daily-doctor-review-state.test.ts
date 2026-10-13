// ★ cwm-dailyreview2-20261014：核對同事覆核 —— 狀態純函數
//   跑法: TZ=UTC npx tsx --test src/lib/payout/daily-doctor-review-state.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasRevenue, snapshotOf, sameSnapshot, reviewStatus, reviewProgress } from './daily-doctor-review-state'

test('快照：只留非 0、兩位小數、次序唔影響', () => {
  assert.deepEqual(snapshotOf({ VISA: 100.004, CASH: 0, MASTER: 20.1 }), { MASTER: 20.1, VISA: 100 })
  assert.ok(sameSnapshot({ A: 1, B: 2 }, { B: 2, A: 1, C: 0 }))
  assert.ok(sameSnapshot({ A: 0.1 + 0.2 }, { A: 0.3 }), '浮點唔誤判')
  assert.ok(!sameSnapshot({ A: 1 }, { A: 1.01 }))
  assert.ok(!sameSnapshot({ A: 1 }, { A: 1, B: 5 }), '多咗一種付款方式 = 有變')
  assert.ok(!sameSnapshot({ A: 1, B: 5 }, { A: 1 }), '少咗一種付款方式 = 有變')
  assert.ok(!sameSnapshot({ A: 100 }, { A: -100 }), '退款變負數 = 有變')
})

test('狀態：冇紀錄 NONE；一樣 OK；任何一格唔同 CHANGED；而家冇數但有紀錄 CHANGED', () => {
  assert.equal(reviewStatus({ A: 1 }, null), 'NONE')
  assert.equal(reviewStatus({ A: 1 }, { snapshot: { A: 1 } }), 'OK')
  assert.equal(reviewStatus({ A: 1, B: 2 }, { snapshot: { A: 1 } }), 'CHANGED')
  assert.equal(reviewStatus({}, { snapshot: { A: 1 } }), 'CHANGED')
  assert.equal(reviewStatus(undefined, { snapshot: {} }), 'OK')
  assert.equal(hasRevenue({ A: 0, B: 0.004 }), false)
  assert.equal(hasRevenue({ A: -50 }), true, '淨係退款都算有數')
})

test('進度：只計有收款嘅日；未核對／有變分開列；冇數但有舊紀錄唔計', () => {
  const days: Array<{ date: string; byMethod: Record<string, number> }> = [
    { date: '2026-10-01', byMethod: {} },
    { date: '2026-10-04', byMethod: { CASH: 5000 } },
    { date: '2026-10-05', byMethod: { MASTER: 4000 } },
    { date: '2026-10-06', byMethod: { VISA: 38750 } },
    { date: '2026-10-07', byMethod: { VISA: 0 } },
  ]
  const reviews = new Map<string, { snapshot: Record<string, number> }>([
    ['2026-10-04', { snapshot: { CASH: 5000 } }],
    ['2026-10-06', { snapshot: { VISA: 38000 } }],
    ['2026-10-07', { snapshot: { VISA: 10 } }],
  ])
  const p = reviewProgress(days, reviews)
  assert.equal(p.total, 3)
  assert.equal(p.ok, 1)
  assert.deepEqual(p.pendingDates, ['2026-10-05'])
  assert.deepEqual(p.changedDates, ['2026-10-06'])
  assert.equal(p.needsAck, true)
  const done = reviewProgress(days.slice(0, 2), new Map<string, { snapshot: Record<string, number> }>([['2026-10-04', { snapshot: { CASH: 5000 } }]]))
  assert.deepEqual([done.total, done.ok, done.needsAck], [1, 1, false])
  assert.equal(reviewProgress([], new Map()).needsAck, false, '成個月冇收款 → 唔使剔')
})
