// ★ cwm-labstmtprog-20261012：Lab 月結單逐店進度
//   跑法: TZ=UTC npx tsx --test src/lib/labdoc/statement-progress.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statementProgress, lastMonthOf, type ProgStatementIn } from './statement-progress'

const S = (o: Partial<ProgStatementIn> & { id: string }): ProgStatementIn => ({ labId: 'hc', status: 'IN_PROGRESS', clinicId: null, uploadClinicId: null, sections: [], ...o })

test('按段計：全部確認 = 已對；部分 = 對數中；冇確認 = 未對；跨店各計一次', () => {
  const r = statementProgress([
    S({ id: 'a', status: 'RECONCILED', sections: [{ clinicId: 'tkw', status: 'CONFIRMED' }, { clinicId: 'tkw', status: 'CONFIRMED' }] }),
    S({ id: 'b', labId: 'gw', sections: [{ clinicId: 'tkw', status: 'CONFIRMED' }, { clinicId: 'tkw', status: 'DIFF' }] }),
    S({ id: 'c', labId: 'kea', sections: [{ clinicId: 'tkw', status: 'CONFIRMED' }, { clinicId: 'yl', status: 'PENDING' }] }),
  ], [])
  const by = Object.fromEntries(r.clinics.map(c => [c.clinicId, c]))
  assert.deepEqual([by.tkw.reconciled, by.tkw.inProgress, by.tkw.open], [2, 1, 0]) // c 喺 tkw 嘅段全確認 → 已對
  assert.deepEqual([by.yl.reconciled, by.yl.inProgress, by.yl.open], [0, 0, 1])
})

test('作廢／重複／已取代唔計；未分段歸單頭店→上傳店→唔知', () => {
  const r = statementProgress([
    S({ id: 'v', status: 'VOID', sections: [{ clinicId: 'yl', status: 'PENDING' }] }),
    S({ id: 'd', status: 'DUPLICATE', clinicId: 'yl' }),
    S({ id: 'x', status: 'EXTRACTING', uploadClinicId: 'yl' }),
    S({ id: 'y', status: 'NEEDS_REVIEW' }),
  ], [])
  assert.deepEqual(r.clinics, [{ clinicId: 'yl', reconciled: 0, inProgress: 0, open: 1, missingLabIds: [],
    todo: [{ kind: 'OPEN', labId: 'hc', providerId: null, docId: 'x', diff: null }] }])
  assert.equal(r.unassigned, 1)
})

test('未收到：有成本但冇嗰間 Lab 喺嗰間店嘅月結單', () => {
  const r = statementProgress(
    [S({ id: 'a', labId: 'hc', sections: [{ clinicId: 'yl', status: 'CONFIRMED' }] })],
    [{ clinicId: 'yl', labId: 'hc' }, { clinicId: 'yl', labId: 'modern' }, { clinicId: 'yl', labId: 'modern' }, { clinicId: 'tw', labId: 'excel' }],
  )
  const by = Object.fromEntries(r.clinics.map(c => [c.clinicId, c]))
  assert.deepEqual(by.yl.missingLabIds, ['modern'])
  assert.deepEqual(by.tw, { clinicId: 'tw', reconciled: 0, inProgress: 0, open: 0, missingLabIds: ['excel'],
    todo: [{ kind: 'MISSING', labId: 'excel', providerId: null }] })
})

test('預設月份 = 上個月（跨年）', () => {
  assert.equal(lastMonthOf('2026-10-12'), '2026-09')
  assert.equal(lastMonthOf('2027-01-05'), '2026-12')
})

// ── 2026-10-12：卡片逐項「Lab × 醫生」 ──
test('未對逐段列：邊間 Lab、邊位醫生、差額；確認咗嘅段唔列', () => {
  const r = statementProgress([
    S({ id: 'hc9', labId: 'hc', sections: [
      { id: 's1', clinicId: 'tw', providerId: 'tse', status: 'DIFF', diff: 440 },
      { id: 's2', clinicId: 'tw', providerId: 'ho', status: 'CONFIRMED' },
    ] }),
  ], [])
  const tw = r.clinics.find(c => c.clinicId === 'tw')!
  assert.deepEqual(tw.todo, [{ kind: 'OPEN', labId: 'hc', providerId: 'tse', docId: 'hc9', sectionId: 's1', diff: 440 }])
  assert.equal(tw.inProgress, 1)
})

test('未收到按 Lab × 醫生：Lab 分開醫生出單，收咗謝醫生嘅、未收何醫生嘅 → 只列何醫生', () => {
  const r = statementProgress(
    [S({ id: 'gw', labId: 'goodwill', sections: [{ id: 's1', clinicId: 'tw', providerId: 'tse', status: 'CONFIRMED' }] })],
    [
      { clinicId: 'tw', labId: 'goodwill', providerId: 'tse' },
      { clinicId: 'tw', labId: 'goodwill', providerId: 'ho' },
      { clinicId: 'tw', labId: 'kea', providerId: 'ho' },
      { clinicId: 'tw', labId: 'kea', providerId: 'ho' },
    ],
  )
  const tw = r.clinics.find(c => c.clinicId === 'tw')!
  assert.deepEqual(tw.todo, [
    { kind: 'MISSING', labId: 'goodwill', providerId: 'ho' },
    { kind: 'MISSING', labId: 'kea', providerId: 'ho' },
  ])
  assert.deepEqual(tw.missingLabIds, ['goodwill', 'kea'])
})

test('段未揀醫生／單未分段 → 當嗰間 Lab 喺嗰間店全部醫生有單（唔誤報未收到）', () => {
  const r = statementProgress(
    [
      S({ id: 'a', labId: 'hc', sections: [{ id: 's1', clinicId: 'tw', providerId: null, status: 'NEEDS_ASSIGN' }] }),
      S({ id: 'b', labId: 'kea', status: 'NEEDS_REVIEW', clinicId: 'tw' }),
    ],
    [{ clinicId: 'tw', labId: 'hc', providerId: 'tse' }, { clinicId: 'tw', labId: 'kea', providerId: 'ho' }],
  )
  const tw = r.clinics.find(c => c.clinicId === 'tw')!
  assert.equal(tw.todo.filter(t => t.kind === 'MISSING').length, 0)
  assert.equal(tw.todo.filter(t => t.kind === 'OPEN').length, 2)
})
