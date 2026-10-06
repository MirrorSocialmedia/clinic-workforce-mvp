import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingPayouts, missingSourceId, isMissingSourceId } from './missing-payouts'

test('未生成月結：戶口診所內、未有 PayoutRun 嘅醫生先出', () => {
  const r = missingPayouts({
    clinicIds: ['tw'],
    assignments: [
      { providerId: 'ho', clinicId: 'tw' },   // 有 run → 唔出
      { providerId: 'lau', clinicId: 'tw' },  // 冇 run → 出
      { providerId: 'tse', clinicId: 'tkw' }, // 唔係呢個戶口嘅店 → 唔出
    ],
    payouts: [{ providerId: 'ho', clinicId: 'tw' }],
  })
  assert.deepEqual(r, [{ providerId: 'lau', clinicId: 'tw' }])
})

test('同一醫生喺另一間店有 run，唔代表呢間店有', () => {
  const r = missingPayouts({
    clinicIds: ['tw', 'tkw'],
    assignments: [{ providerId: 'ho', clinicId: 'tw' }, { providerId: 'ho', clinicId: 'tkw' }],
    payouts: [{ providerId: 'ho', clinicId: 'tkw' }],
  })
  assert.deepEqual(r, [{ providerId: 'ho', clinicId: 'tw' }])
})

test('重複 assignment 只出一行；全部有 run → 空', () => {
  assert.deepEqual(missingPayouts({
    clinicIds: ['tw'],
    assignments: [{ providerId: 'a', clinicId: 'tw' }, { providerId: 'a', clinicId: 'tw' }],
    payouts: [],
  }), [{ providerId: 'a', clinicId: 'tw' }])
  assert.deepEqual(missingPayouts({
    clinicIds: ['tw'],
    assignments: [{ providerId: 'a', clinicId: 'tw' }],
    payouts: [{ providerId: 'a', clinicId: 'tw' }],
  }), [])
})

test('佔位 sourceId 認得返、唔會撞真 cuid', () => {
  const id = missingSourceId('p1', 'c1')
  assert.equal(isMissingSourceId(id), true)
  assert.equal(isMissingSourceId('clx123abc'), false)
})
