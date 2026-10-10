// ★ cwm-dailyv2-20261007 ④：每日大數逐格核對 —— 狀態判斷純函數測試
//   cellState / cellTickable 喺 daily-cell-state.ts（零 prisma，CI 無 DB 都得）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellState, cellTickable } from './daily-cell-state'
import { validateCellRange } from './daily-cell-check' // ★ cwm-dailyv3-20261010 §5a：純函數（prisma 唔會 connect）

test('cellState：有數未 tick → OPEN', () => {
  assert.equal(cellState(4000, null), 'OPEN')
  assert.equal(cellState(500, undefined), 'OPEN')
  assert.equal(cellState(0, null), 'OPEN') // 冇數又冇 tick：唔係 STALE（STALE 要「有 tick」）
})

test('cellState：同額 → OK（浮點誤差容忍）', () => {
  assert.equal(cellState(4000, 4000), 'OK')
  assert.equal(cellState(4000.004, 4000), 'OK')
  assert.equal(cellState(3980, 3980), 'OK')
})

test('cellState：唔同額 → CHANGED（差一仙都要重新核對）', () => {
  assert.equal(cellState(3980, 4000), 'CHANGED')
  assert.equal(cellState(4000.01, 4000), 'CHANGED')
  assert.equal(cellState(3999.99, 4000), 'CHANGED')
})

test('cellState：0 但有 tick → STALE（被 void 而家冇數，等人取消）', () => {
  assert.equal(cellState(0, 500), 'STALE')
  assert.equal(cellState(null, 500), 'STALE')
  assert.equal(cellState(undefined, 500), 'STALE')
})

test('「有數先有格」：0 或 null 唔出 checkbox', () => {
  assert.equal(cellTickable(0), false)
  assert.equal(cellTickable(null), false)
  assert.equal(cellTickable(undefined), false)
  assert.equal(cellTickable(0.004), false) // round2 後係 0
  assert.equal(cellTickable(0.01), true)
  assert.equal(cellTickable(4000), true)
})
test('§5a validateCellRange：合法範圍 / 單日', () => {
  assert.deepEqual(validateCellRange('2026-09-01', '2026-09-30'), { ok: true, from: '2026-09-01', to: '2026-09-30' })
  assert.deepEqual(validateCellRange('2026-10-09', '2026-10-09'), { ok: true, from: '2026-10-09', to: '2026-10-09' })
  // 62 日（DAILY_MAX_DAYS）邊界：2026-08-11..2026-10-11 = 62 日
  assert.equal(validateCellRange('2026-08-11', '2026-10-11').ok, true)
})

test('§5a validateCellRange：超 62 日 / 起訖倒轉 / 格式錯 → 400 語義', () => {
  const over = validateCellRange('2026-08-10', '2026-10-11') // 63 日
  assert.equal(over.ok, false)
  if (!over.ok) assert.match(over.error, /62/)
  const rev = validateCellRange('2026-09-02', '2026-09-01')
  assert.equal(rev.ok, false)
  assert.equal(validateCellRange('2026/09/01', '2026-09-02').ok, false)
  // 註：'2026-02-30' 呢類唔存在嘅日會跟 addDaysStr 滾月（同 loadDailyReport 嘅 daysBetween 同一現有行為），
  //     唔喺呢度另立嚴格度 → 保持一致。
})
