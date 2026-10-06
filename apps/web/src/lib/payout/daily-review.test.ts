// ★ cwm-dailyreview-20261006：醫生月結預覽每日收款（純函數）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeDailyReview, monthDays } from './daily-review'

test('monthDays：月頭至月尾（包閏年二月）', () => {
  assert.deepEqual(monthDays('2026-10'), { from: '2026-10-01', to: '2026-10-31' })
  assert.deepEqual(monthDays('2028-02'), { from: '2028-02-01', to: '2028-02-29' })
})

test('mergeDailyReview：只列醫生有收款嘅日子；狀態跟店舖；合計＝逐日加埋', () => {
  const r = mergeDailyReview(
    [
      { date: '2026-10-01', doctorRaw: 0 },
      { date: '2026-10-02', doctorRaw: 4860 },
      { date: '2026-10-03', doctorRaw: 6200.5 },
      { date: '2026-10-05', doctorRaw: 5300 },
      { date: '2026-10-06', doctorRaw: 300 }, // 全店冇店舖營收（例如只得 FREE SP）
    ],
    [
      { date: '2026-10-02', storeTotal: 18420, status: 'CHECKED', check: { nurseName: '陳美玲', checkedAt: '2026-10-02T10:30:00Z', amount: 18420 } },
      { date: '2026-10-03', storeTotal: 22100, status: 'UNCHECKED', check: null },
      { date: '2026-10-05', storeTotal: 12840, status: 'CHANGED', check: { nurseName: '陳美玲', checkedAt: '2026-10-05T10:42:00Z', amount: 12340 } },
    ],
  )
  assert.equal(r.days.length, 4)
  assert.equal(r.doctorTotal, 16660.5)
  assert.deepEqual(r.counts, { checked: 1, changed: 1, unchecked: 1 })
  assert.equal(r.needsAck, true)
  assert.equal(r.days.find(d => d.date === '2026-10-06')!.status, 'NONE')
  assert.equal(r.days.find(d => d.date === '2026-10-05')!.checkedAmount, 12340)
})

test('mergeDailyReview：全部已核對（或唔使核對）→ 唔使剔', () => {
  const r = mergeDailyReview(
    [{ date: '2026-10-02', doctorRaw: 100 }, { date: '2026-10-06', doctorRaw: 50 }],
    [{ date: '2026-10-02', storeTotal: 100, status: 'CHECKED', check: { nurseName: 'A', checkedAt: '2026-10-02T10:00:00Z', amount: 100 } }],
  )
  assert.equal(r.needsAck, false)
})
