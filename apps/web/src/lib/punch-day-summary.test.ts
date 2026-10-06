// ★ cwm-ledgerpunch-20261006：手機時間帳戶逐日打卡時間（純函數）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizePunchDays, punchLine } from './punch-day-summary'

const hk = (s: string) => new Date(`${s}+08:00`)

test('summarizePunchDays：按香港日分；一日多次 = 上班最早、放工最遲、午膳出最早、午膳入最遲', () => {
  const r = summarizePunchDays([
    { punchType: 'CLOCK_IN', effectiveTime: hk('2026-10-01T09:58:00') },
    { punchType: 'LUNCH_START', effectiveTime: hk('2026-10-01T13:30:00') },
    { punchType: 'LUNCH_END', effectiveTime: hk('2026-10-01T14:31:00') },
    { punchType: 'CLOCK_OUT', effectiveTime: hk('2026-10-01T15:00:00') }, // 調鋪：第一間店放工
    { punchType: 'CLOCK_IN', effectiveTime: hk('2026-10-01T15:40:00') }, // 第二間店上班
    { punchType: 'CLOCK_OUT', effectiveTime: hk('2026-10-01T21:31:00') },
    { punchType: 'CLOCK_IN', effectiveTime: hk('2026-10-02T00:30:00') }, // UTC 係 10-01，HK 係 10-02
  ])
  assert.deepEqual(r['2026-10-01'], { in: '09:58', out: '21:31', lunchOut: '13:30', lunchIn: '14:31' })
  assert.equal(r['2026-10-02'].in, '00:30')
  assert.equal(r['2026-10-02'].out, null)
})

test('punchLine：冇打嘅照寫，唔留空', () => {
  assert.equal(punchLine({ in: '09:58', out: '21:31', lunchOut: '13:30', lunchIn: '14:31' }), '打卡 09:58–21:31 · 午膳 13:30–14:31')
  assert.equal(punchLine({ in: '09:55', out: null, lunchOut: null, lunchIn: null }), '打卡 09:55–？（未打放工） · 午膳 冇打')
  assert.equal(punchLine({ in: null, out: '18:00', lunchOut: '13:00', lunchIn: null }), '打卡 ？（未打上班）–18:00 · 午膳 13:00–？')
  assert.equal(punchLine(undefined), '冇打卡紀錄')
})
