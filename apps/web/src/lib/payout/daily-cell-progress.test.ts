/**
 * ★ cwm-storedoc-20261011（方案一）：逐格剔分組／進度
 *   跑法: TZ=UTC npx tsx --test src/lib/payout/daily-cell-progress.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellGroupOf, cellFlagText, cellProgressOf, rowCellProgressOf, type ProgressCell } from './daily-cell-state'

const BOTH = { storeIncome: true, doctorIncome: true }
const DOC = { storeIncome: false, doctorIncome: true }
const NONE = { storeIncome: false, doctorIncome: false }
const STORE_ONLY = { storeIncome: true, doctorIncome: false }

test('分組＋欄名細字跟兩個旗', () => {
  assert.equal(cellGroupOf(BOTH), 'STORE')
  assert.equal(cellGroupOf(STORE_ONLY), 'STORE')
  assert.equal(cellGroupOf(DOC), 'DOCTOR_ONLY')
  assert.equal(cellGroupOf(NONE), 'NONE')
  assert.equal(cellFlagText(DOC), '店✗ 醫✓')
  assert.equal(cellFlagText(BOTH), '店✓ 醫✓')
})

// 圖示 A：謝德輝 Visa/Master/FPS 已剔、Free SP 已剔；林醫生 Cash 未剔、Visa 剔完有變、Credit 未剔；雜項 Cash 未剔
const cells: ProgressCell[] = [
  { ...BOTH, current: 3080, checked: 3080 }, { ...BOTH, current: 3000, checked: 3000 }, { ...BOTH, current: 3000, checked: 3000 },
  { ...DOC, current: 580, checked: 580 },
  { ...BOTH, current: 2000, checked: null }, { ...BOTH, current: 1500, checked: 1400 }, { ...NONE, current: 250, checked: null },
  { ...BOTH, current: 150, checked: null },
  { ...BOTH, current: 0, checked: null }, // 冇數唔計
]

test('核對框進度：店舖 3/6（有變唔算）、只計醫生 1/1、兩樣都唔計 0/1（唔入進度）', () => {
  const p = cellProgressOf(cells)
  assert.deepEqual(p.store, { done: 3, total: 6 })
  assert.deepEqual(p.doctorOnly, { done: 1, total: 1 })
  assert.deepEqual(p.none, { done: 0, total: 1 })
})

test('行細字：謝德輝 店 3/3、醫 4/4；林醫生 店 0/2、醫 0/2', () => {
  assert.deepEqual(rowCellProgressOf(cells.slice(0, 4)), { store: { done: 3, total: 3 }, doctor: { done: 4, total: 4 } })
  assert.deepEqual(rowCellProgressOf(cells.slice(4, 7)), { store: { done: 0, total: 2 }, doctor: { done: 0, total: 2 } })
})
