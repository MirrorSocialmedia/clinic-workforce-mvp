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
  assert.deepEqual(r.clinics, [{ clinicId: 'yl', reconciled: 0, inProgress: 0, open: 1, missingLabIds: [] }])
  assert.equal(r.unassigned, 1)
})

test('未收到：有成本但冇嗰間 Lab 喺嗰間店嘅月結單', () => {
  const r = statementProgress(
    [S({ id: 'a', labId: 'hc', sections: [{ clinicId: 'yl', status: 'CONFIRMED' }] })],
    [{ clinicId: 'yl', labId: 'hc' }, { clinicId: 'yl', labId: 'modern' }, { clinicId: 'yl', labId: 'modern' }, { clinicId: 'tw', labId: 'excel' }],
  )
  const by = Object.fromEntries(r.clinics.map(c => [c.clinicId, c]))
  assert.deepEqual(by.yl.missingLabIds, ['modern'])
  assert.deepEqual(by.tw, { clinicId: 'tw', reconciled: 0, inProgress: 0, open: 0, missingLabIds: ['excel'] })
})

test('預設月份 = 上個月（跨年）', () => {
  assert.equal(lastMonthOf('2026-10-12'), '2026-09')
  assert.equal(lastMonthOf('2027-01-05'), '2026-12')
})
