import { test } from 'node:test'
import assert from 'node:assert/strict'
import { amountInWords, amountFigures, integerWords, splitWords, toCents } from './words'

test('integerWords 基本', () => {
  assert.equal(integerWords(1), 'ONE')
  assert.equal(integerWords(15), 'FIFTEEN')
  assert.equal(integerWords(100), 'ONE HUNDRED')
  assert.equal(integerWords(105), 'ONE HUNDRED AND FIVE')
  assert.equal(integerWords(1005), 'ONE THOUSAND AND FIVE')
  assert.equal(integerWords(17220), 'SEVENTEEN THOUSAND TWO HUNDRED AND TWENTY')
  assert.equal(integerWords(117598), 'ONE HUNDRED AND SEVENTEEN THOUSAND FIVE HUNDRED AND NINETY EIGHT')
  assert.equal(integerWords(1000000), 'ONE MILLION')
  assert.equal(integerWords(2000300), 'TWO MILLION THREE HUNDRED')
  assert.equal(integerWords(2000030), 'TWO MILLION AND THIRTY')
})

test('amountInWords 有仙／冇仙', () => {
  assert.equal(amountInWords(17220), 'SEVENTEEN THOUSAND TWO HUNDRED AND TWENTY ONLY')
  assert.equal(amountInWords('9915.50'), 'NINE THOUSAND NINE HUNDRED AND FIFTEEN AND CENTS FIFTY ONLY')
  assert.equal(amountInWords(0.05), 'CENTS FIVE ONLY')
  // 浮點：0.1+0.2
  assert.equal(amountInWords(0.1 + 0.2), 'CENTS THIRTY ONLY')
  assert.equal(amountInWords(15675.999), 'FIFTEEN THOUSAND SIX HUNDRED AND SEVENTY SIX ONLY')
})

test('0／負數／唔係數字 拋錯', () => {
  assert.throws(() => toCents(0))
  assert.throws(() => toCents(-5))
  assert.throws(() => toCents('abc'))
})

test('amountFigures 千位＋兩位小數＋星', () => {
  assert.equal(amountFigures(17220), '**17,220.00**')
  assert.equal(amountFigures('9915.5'), '**9,915.50**')
  assert.equal(amountFigures(1234567.891), '**1,234,567.89**')
})

test('splitWords 按字分兩行、補星', () => {
  const w = amountInWords(117598.3)
  const r = splitWords(w, 40, 60)!
  assert.ok(r[0].length <= 40 && r[1].length <= 60)
  assert.equal((r[0] + ' ' + r[1]).replace(/ \*+$/, ''), w)
  assert.ok(r[1].endsWith('***'))
  // 一行塞得落
  const s = splitWords('ONE HUNDRED ONLY', 40, 60)!
  assert.ok(s[0].startsWith('ONE HUNDRED ONLY *'))
  assert.equal(s[0].length, 40)
  assert.match(s[1], /^\*+$/)
  // 塞唔落 → null
  assert.equal(splitWords(w, 10, 10), null)
})
