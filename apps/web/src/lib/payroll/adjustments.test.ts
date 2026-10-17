/**
 * ★ cwm-payadj-20261017 ②：計糧調整 lib — 驗證／hash／sum（MD §2.7）
 * 跑法: npx tsx --test src/lib/payroll/adjustments.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateAdjustmentInput,
  sumAdjustments,
  adjHashOf,
  signedAmount,
  ADJ_EMPTY_HASH,
  type AdjRow,
} from './adjustments'

describe('validateAdjustmentInput', () => {
  it('有效：number 金額 + ADD + PRE_MPF', () => {
    const v = validateAdjustmentInput({ amount: 500, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: '補差額' })
    assert.equal(v.ok, true)
    if (v.ok) assert.deepEqual(v.value, { amount: 500, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: '補差額' })
  })

  it('有效：數字字串（trim + 2 位小數）', () => {
    const v = validateAdjustmentInput({ amount: ' 123.45 ', sign: 'DEDUCT', mpfTiming: 'POST_MPF', reason: 'x'.repeat(200) })
    assert.equal(v.ok, true)
    if (v.ok) assert.equal(v.value.amount, 123.45)
  })

  it('有效：Deduct 正數金額（方向由 sign 決定）', () => {
    const v = validateAdjustmentInput({ amount: 1000, sign: 'DEDUCT', mpfTiming: 'POST_MPF', reason: '預支' })
    assert.equal(v.ok, true)
  })

  it('拒：0 / 負數 / 超過上限', () => {
    assert.equal(validateAdjustmentInput({ amount: 0, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'a' }).ok, false)
    assert.equal(validateAdjustmentInput({ amount: -5, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'a' }).ok, false)
    assert.equal(validateAdjustmentInput({ amount: 1_000_001, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'a' }).ok, false)
  })

  it('拒：3 位小數 / 指數 / 非數字字串', () => {
    assert.equal(validateAdjustmentInput({ amount: '1.234', sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'a' }).ok, false)
    assert.equal(validateAdjustmentInput({ amount: '1e2', sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'a' }).ok, false)
    assert.equal(validateAdjustmentInput({ amount: 'abc', sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'a' }).ok, false)
  })

  // ★ PR #81 教訓：唔收 [5]、{valueOf}
  it('拒：陣列 / object（valueOf）', () => {
    assert.equal(validateAdjustmentInput({ amount: [5] as any, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'a' }).ok, false)
    assert.equal(
      validateAdjustmentInput({ amount: { valueOf: () => 5 } as any, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'a' }).ok, false,
    )
  })

  it('拒：sign / mpfTiming 白名單', () => {
    assert.equal(validateAdjustmentInput({ amount: 5, sign: 'X', mpfTiming: 'PRE_MPF', reason: 'a' }).ok, false)
    assert.equal(validateAdjustmentInput({ amount: 5, sign: 'ADD', mpfTiming: 'MIDDLE', reason: 'a' }).ok, false)
  })

  it('拒：reason 空白 / 超過 200', () => {
    assert.equal(validateAdjustmentInput({ amount: 5, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: '   ' }).ok, false)
    assert.equal(validateAdjustmentInput({ amount: 5, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'x'.repeat(201) }).ok, false)
  })

  it('拒：body 唔係 object', () => {
    assert.equal(validateAdjustmentInput(null).ok, false)
    assert.equal(validateAdjustmentInput('str').ok, false)
    assert.equal(validateAdjustmentInput([1]).ok, false)
  })
})

describe('sumAdjustments', () => {
  const row = (id: string, amount: number, mpfTiming: 'PRE_MPF' | 'POST_MPF'): AdjRow => ({
    id, amount, mpfTiming, reason: 'r',
  })

  it('分 timing 加總 + round2', () => {
    const s = sumAdjustments([row('a', 100, 'PRE_MPF'), row('b', 50.5, 'PRE_MPF'), row('c', -200, 'POST_MPF')])
    assert.equal(s.pre, 150.5)
    assert.equal(s.post, -200)
  })

  it('空 = 0 + ADJ_EMPTY_HASH', () => {
    const s = sumAdjustments([])
    assert.equal(s.pre, 0)
    assert.equal(s.post, 0)
    assert.equal(s.hash, ADJ_EMPTY_HASH)
  })

  it('hash 次序無關（同集不同排 = 同 hash）', () => {
    const rs = [row('a', 1, 'PRE_MPF'), row('b', 2, 'POST_MPF'), row('c', 3, 'PRE_MPF')]
    const h1 = adjHashOf(rs)
    const h2 = adjHashOf([...rs].reverse())
    assert.equal(h1, h2)
    assert.equal(sumAdjustments(rs).hash, sumAdjustments([...rs].reverse()).hash)
  })

  it('hash 對 amount / timing 敏感', () => {
    const h0 = adjHashOf([row('a', 1, 'PRE_MPF')])
    assert.notEqual(adjHashOf([row('a', 2, 'PRE_MPF')]), h0)
    assert.notEqual(adjHashOf([row('a', 1, 'POST_MPF')]), h0)
    assert.notEqual(adjHashOf([row('a', 1, 'PRE_MPF'), row('b', 5, 'PRE_MPF')]), h0)
  })
})

describe('signedAmount', () => {
  it('ADD = 正、DEDUCT = 負', () => {
    assert.equal(signedAmount({ amount: 100, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'a' }), 100)
    assert.equal(signedAmount({ amount: 100, sign: 'DEDUCT', mpfTiming: 'POST_MPF', reason: 'a' }), -100)
  })
})
