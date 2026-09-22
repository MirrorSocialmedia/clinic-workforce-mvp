/**
 * ★ cwm-provroster S3：buildCellInfo 次序（休假 > 例外含 OFF > 固定表 > 冇排）
 * 跑法: cd apps/web && npx tsx --test src/lib/provider-cell.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCellInfo, mondayOf } from './provider-cell'
import { DEFAULT_SLOTS } from './provider-pattern'

const slots = DEFAULT_SLOTS
const shift = (slot: string | null, extra: any = {}) => ({ id: 's1', slot, startTime: '2026-09-21T01:00:00.000Z', endTime: '2026-09-21T05:30:00.000Z', note: null, ...extra })

test('冇排', () => {
  const c = buildCellInfo({ patternSlot: null, shift: null, leave: null, slots })
  assert.equal(c.kind, 'none')
})
test('固定表 FULL → 全日 + 診所時段', () => {
  const c = buildCellInfo({ patternSlot: 'FULL', shift: null, leave: null, slots })
  assert.deepEqual([c.kind, c.label, c.time, c.isException], ['duty', '全日', '10:00–20:00', false])
})
test('例外 slot=null → 用實際時間（之前當 FULL 顯示「～」）', () => {
  const c = buildCellInfo({ patternSlot: 'FULL', shift: shift(null), leave: null, slots })
  assert.equal(c.kind, 'duty'); assert.equal(c.label, '09:00–13:30'); assert.equal(c.isException, true); assert.equal(c.patternSlot, 'FULL')
})
test('OFF 例外 → 唔返 + 備註（之前顯示成「·」）', () => {
  const c = buildCellInfo({ patternSlot: 'AM', shift: shift('OFF', { note: '調去油麻地' }), leave: null, slots })
  assert.deepEqual([c.kind, c.label, c.note], ['off', '唔返', '調去油麻地'])
})
test('休假蓋過例外同固定表', () => {
  const c = buildCellInfo({ patternSlot: 'FULL', shift: shift('AM'), leave: { id: 'l1', note: '年假' }, slots })
  assert.deepEqual([c.kind, c.note], ['leave', '年假'])
})
test('mondayOf：日=6、一=0、六=5', () => {
  assert.deepEqual([mondayOf(0), mondayOf(1), mondayOf(6)], [6, 0, 5])
})
