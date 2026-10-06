// ★ cwm-spbulk-20261006：批量確認請求驗證（純函數）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBulkItems, BULK_CONFIRM_MAX } from './sp-status'

test('parseBulkItems：正常＋去重（同 id 同金額只留一個）', () => {
  const r = parseBulkItems([{ id: 'a', amount: 40 }, { id: 'b', amount: 0 }, { id: 'a', amount: 40 }])
  assert.deepEqual(r, [{ id: 'a', amount: 40 }, { id: 'b', amount: 0 }])
})

test('parseBulkItems：空／太多 → throw', () => {
  assert.throws(() => parseBulkItems([]), /BULK_EMPTY/)
  assert.throws(() => parseBulkItems(undefined), /BULK_EMPTY/)
  const many = Array.from({ length: BULK_CONFIRM_MAX + 1 }, (_, i) => ({ id: `x${i}`, amount: 1 }))
  assert.throws(() => parseBulkItems(many), /BULK_TOO_MANY/)
})

test('parseBulkItems：格式錯 → throw（冇 id、金額唔係數字、負數、字串金額）', () => {
  assert.throws(() => parseBulkItems([{ amount: 40 }]), /BULK_INVALID/)
  assert.throws(() => parseBulkItems([{ id: 'a', amount: '40' }]), /BULK_INVALID/)
  assert.throws(() => parseBulkItems([{ id: 'a', amount: -1 }]), /BULK_INVALID/)
  assert.throws(() => parseBulkItems([{ id: 'a', amount: Number.NaN }]), /BULK_INVALID/)
})

test('parseBulkItems：同一筆兩個唔同金額 → throw（唔估邊個啱）', () => {
  assert.throws(() => parseBulkItems([{ id: 'a', amount: 40 }, { id: 'a', amount: 80 }]), /BULK_INVALID/)
})
