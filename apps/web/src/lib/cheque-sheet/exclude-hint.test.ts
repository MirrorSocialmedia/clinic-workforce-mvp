/**
 * ★ cwm-chequeexcl-20261004：模版唔匯出員工 —— 試用期提示
 * 跑法: TZ=UTC npx tsx --test src/lib/cheque-sheet/exclude-hint.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { excludeHint } from './exclude-hint'
import { normalizeSheetConfig } from './config'

describe('excludeHint', () => {
  it('試用期中（3 個月）：入職第幾日＋最後一日', () => {
    assert.deepEqual(excludeHint('2026-09-08', true, '2026-10-04'), { kind: 'PROBATION', lastDay: '2026-12-07', dayNo: 27 })
    assert.deepEqual(excludeHint('2026-09-08', false, '2026-10-04'), { kind: 'PROBATION', lastDay: '2026-12-07', dayNo: 27 })
  })
  it('試用期最後一日仲係試用期；第二日起唔係', () => {
    assert.equal(excludeHint('2026-07-15', false, '2026-10-14')?.kind, 'PROBATION')
    assert.equal(excludeHint('2026-07-15', false, '2026-10-15'), null)
  })
  it('已過試用期仲剔走緊 → 紅色提示；照出就冇提示', () => {
    assert.deepEqual(excludeHint('2026-06-02', true, '2026-10-04'), { kind: 'PASSED_EXCLUDED', lastDay: '2026-09-01' })
    assert.equal(excludeHint('2026-06-02', false, '2026-10-04'), null)
  })
  it('冇入職日 = 冇提示', () => assert.equal(excludeHint(null, true, '2026-10-04'), null))
})

describe('normalizeSheetConfig.excludedEmployeeIds', () => {
  it('去重、只收字串；冇 = 空（舊模版照出全部）', () => {
    assert.deepEqual(normalizeSheetConfig({ excludedEmployeeIds: ['a', 'a', 3, '', 'b'] }).excludedEmployeeIds, ['a', 'b'])
    assert.deepEqual(normalizeSheetConfig({}).excludedEmployeeIds, [])
  })
})
