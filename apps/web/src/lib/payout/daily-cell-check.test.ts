// ★ cwm-dailyv2-20261007 ④：每日大數逐格核對 —— 狀態判斷純函數測試
//   cellState / cellTickable 喺 daily-cell-state.ts（零 prisma，CI 無 DB 都得）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellState, cellTickable } from './daily-cell-state'

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
