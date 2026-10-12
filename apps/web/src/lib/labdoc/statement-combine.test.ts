// ★ 2026-10-12：「兩份加埋一齊對」— 組 = 有 combineWithSectionId 嘅段 ＋ 俾人指住嘅段；主段 = 最早上傳
//   跑法: TZ=UTC npx tsx --test src/lib/labdoc/statement-combine.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupFromScope, isNonPrimaryMember } from './statement-combine'

const R = (id: string, at: string, combineWithSectionId: string | null = null) => ({
  id, documentId: `doc-${id}`, combineWithSectionId, document: { createdAt: new Date(at) },
})

test('冇人加埋 → 唔係組', () => {
  assert.equal(groupFromScope([R('a', '2026-10-01'), R('b', '2026-10-02')]), null)
})

test('後一份指前一份 → 組；主段 = 最早上傳；唔關事嘅段唔入組', () => {
  const g = groupFromScope([R('b', '2026-10-05', 'a'), R('a', '2026-10-01'), R('x', '2026-09-30')])
  assert.ok(g)
  assert.equal(g.primaryId, 'a')
  assert.deepEqual(g.memberIds, ['a', 'b'])
})

test('三份：c→a、b→a → 三段一組，按上傳時間排', () => {
  const g = groupFromScope([R('c', '2026-10-09', 'a'), R('b', '2026-10-05', 'a'), R('a', '2026-10-01')])
  assert.deepEqual(g?.memberIds, ['a', 'b', 'c'])
})

test('對象作廢咗（唔喺範圍）→ 只剩一段 → 唔係組', () => {
  assert.equal(groupFromScope([R('b', '2026-10-05', 'a')]), null)
})

test('同時上傳 → 按 id 排，結果穩定', () => {
  const g = groupFromScope([R('z', '2026-10-01', 'y'), R('y', '2026-10-01')])
  assert.equal(g?.primaryId, 'y')
})

test('isNonPrimaryMember：只有組入面嘅「其他段」先係 true', () => {
  assert.equal(isNonPrimaryMember('a', null), false)
  assert.equal(isNonPrimaryMember('a', { mode: 'COST' }), false)
  assert.equal(isNonPrimaryMember('a', { group: { primarySectionId: 'a' } }), false)
  assert.equal(isNonPrimaryMember('b', { group: { primarySectionId: 'a' } }), true)
})

test('isNonPrimaryMember：主段唔喺有效段（作廢咗）→ 當自己計，唔會漏數', () => {
  const rj = { group: { primarySectionId: 'a' } }
  assert.equal(isNonPrimaryMember('b', rj, new Set(['a', 'b'])), true)
  assert.equal(isNonPrimaryMember('b', rj, new Set(['b'])), false)
})
