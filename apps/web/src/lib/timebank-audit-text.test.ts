// ★ cwm-empoverview-20261014：操作記錄人話
//   跑法: TZ=UTC npx tsx --test src/lib/timebank-audit-text.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeTimebankAudit, fmtMinutesSigned } from './timebank-audit-text'

const row = (action: string, notes: unknown, after?: unknown, before?: unknown) => ({
  action, notes: typeof notes === 'string' ? notes : notes == null ? null : JSON.stringify(notes),
  afterJson: after == null ? null : JSON.stringify(after), beforeJson: before == null ? null : JSON.stringify(before),
})

test('分鐘格式', () => {
  assert.equal(fmtMinutesSigned(36), '+36 分鐘')
  assert.equal(fmtMinutesSigned(-47), '−47 分鐘')
  assert.equal(fmtMinutesSigned(-65), '−1 小時 5 分')
  assert.equal(fmtMinutesSigned(-480), '−8 小時')
  assert.equal(fmtMinutesSigned(0), '0 分鐘')
})

test('補鐘：唔出 41131 分呢類誤導數；出 −47 分鐘＋日期類型原因', () => {
  const t = describeTimebankAudit(row('TIMEBANK_MAKEUP', { delta: -47, date: '2026-10-09', reason: '塞車', targetType: 'LATE' }, { balanceMinutes: 41084 }, { balanceMinutes: 41131 }))
  assert.deepEqual(t, { title: '補鐘（扣 OT 鐘）', delta: -47, detail: '補 10-09 遲到 · 原因：塞車' })
  assert.ok(!JSON.stringify(t).includes('41131'))
  const b = describeTimebankAudit(row('TIMEBANK_MAKEUP', { delta: -10, date: '2026-10-06', reason: '批', targetType: 'EARLY_LEAVE', source: 'BATCH' }))
  assert.equal(b.detail, '補 10-06 早走 · 原因：批 · 批量補鐘')
})

test('補回 OT：JSON 變一句話', () => {
  const t = describeTimebankAudit(row('TIMEBANK_OT_BACKPAY', 'script：補回 2026-09 少計 OT 36 分鐘（記入 2026-10）',
    { sourceMonth: '2026-09', targetMonth: '2026-10', minutes: 36, threshold: 15, days: [{ date: '2026-09-03', credited: 0, correct: 12, diff: 12 }, { date: '2026-09-15', credited: 0, correct: 24, diff: 24 }] }))
  assert.equal(t.title, '補回之前少計嘅 OT')
  assert.equal(t.delta, 36)
  assert.equal(t.detail, '9 月 OT 門檻設錯（15 分鐘）少計咗，補入 10 月：09-03 +12、09-15 +24')
  assert.ok(!t.detail.includes('{'))
})

test('其他動作', () => {
  assert.deepEqual(describeTimebankAudit(row('TIMEBANK_CONVERT', { delta: -480, days: 1, direction: 'to_leave' })), { title: 'OT 鐘換假', delta: -480, detail: '用 OT 鐘換 1 日補假' })
  assert.equal(describeTimebankAudit(row('TIMEBANK_REST_TO_ACCOUNT', { days: 1, minutes: 480 })).delta, 480)
  assert.equal(describeTimebankAudit(row('TIMEBANK_ABSENT_DEDUCT', { delta: -540, date: '2026-10-02' })).detail, '10-02 缺勤，用 OT 鐘抵')
  const init = describeTimebankAudit(row('TIMEBANK_INIT_ADJUST', { minutes: 300, effectiveMonth: '2026-01', reason: '舊系統' }, { initMinutes: 300 }, { initMinutes: 0 }))
  assert.equal(init.delta, 300)
  assert.match(init.detail, /2026-01/)
  assert.match(describeTimebankAudit(row('TIMEBANK_MAKEUP_BATCH', { requested: 5, success: 4, skipped: 1, failed: 0, reason: 'x' })).detail, /成功 4/)
})

test('壞資料唔爆：notes 唔係 JSON／null；未知動作嘅 JSON 唔出', () => {
  assert.doesNotThrow(() => describeTimebankAudit(row('TIMEBANK_MAKEUP', 'not json')))
  assert.equal(describeTimebankAudit(row('TIMEBANK_MAKEUP', null)).delta, null)
  assert.equal(describeTimebankAudit(row('TIMEBANK_SOMETHING', { a: 1 })).detail, '')
  assert.equal(describeTimebankAudit(row('TIMEBANK_SOMETHING', '純文字備註')).detail, '純文字備註')
})
