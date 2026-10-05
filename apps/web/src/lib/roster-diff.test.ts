/**
 * ★ 2026-09-30 [cwm-rosterjoin]：編更差額「應返」只計在職日
 * 跑法: TZ=UTC npx tsx --test src/lib/roster-diff.test.ts
 *
 * 背景：計糧明細頁自己計「整月曆日 − 假期」× 9h —— 月中入職員工冇排班嗰啲日都當應返，
 *   9 月 30 日 − 8 日假 = 22 日 = 198h vs 已編 135h → 差額 −63h（假）。
 *   另：resignedAt 係「最後工作日翌日」，舊版當最後工作日用 → 月中離職多計一日應返（−9h）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeRosterDiff } from './roster-hours'

const SEP = { monthStartStr: '2026-09-01', monthEndStr: '2026-09-30' }
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-09-${String(from + i).padStart(2, '0')}`)

describe('computeRosterDiff', () => {
  it('9/8 入職、在職期內 8 日假、編咗 15 日 × 9h → 應返 135h、差額 0（唔再係 −63h）', () => {
    const r = computeRosterDiff({ ...SEP, joinStr: '2026-09-08', lastWorkDayStr: null, leaveDates: days(9, 16), rosterMinutes: 135 * 60 })
    assert.equal(r.expectedMinutes, (23 - 8) * 9 * 60)
    assert.equal(r.diffMinutes, 0)
  })

  it('入職前嘅假期日唔扣（範圍外剔走）', () => {
    const r = computeRosterDiff({ ...SEP, joinStr: '2026-09-16', lastWorkDayStr: null, leaveDates: ['2026-09-10', '2026-09-20'], rosterMinutes: 14 * 9 * 60 })
    assert.equal(r.expectedMinutes, (15 - 1) * 9 * 60)
    assert.equal(r.diffMinutes, 0)
  })

  it('全月在職：同舊式一樣（30 日 − 8 日假）', () => {
    const r = computeRosterDiff({ ...SEP, joinStr: '2025-01-01', lastWorkDayStr: null, leaveDates: days(1, 8), rosterMinutes: 22 * 9 * 60 })
    assert.equal(r.expectedMinutes, 198 * 60)
    assert.equal(r.diffMinutes, 0)
  })

  it('9/15 最後工作日（resignedAt = 9/16）→ 應返 15 日，唔係 16 日', () => {
    const r = computeRosterDiff({ ...SEP, joinStr: '2025-01-01', lastWorkDayStr: '2026-09-15', leaveDates: [], rosterMinutes: 15 * 9 * 60 })
    assert.equal(r.expectedMinutes, 15 * 9 * 60)
    assert.equal(r.diffMinutes, 0)
  })

  it('下月先入職 → 全 0', () => {
    const r = computeRosterDiff({ ...SEP, joinStr: '2026-10-02', lastWorkDayStr: null, leaveDates: [], rosterMinutes: 0 })
    assert.deepEqual(r, { expectedMinutes: 0, rosterMinutes: 0, diffMinutes: 0, unscheduled: false })
  })

  it('冇排更又冇假 → 未排更（差額 0，唔係欠鐘）', () => {
    const r = computeRosterDiff({ ...SEP, joinStr: '2026-09-20', lastWorkDayStr: null, leaveDates: [], rosterMinutes: 0 })
    assert.equal(r.unscheduled, true)
    assert.equal(r.diffMinutes, 0)
  })

  it('假期日重複（跨單重疊）只計一次', () => {
    const r = computeRosterDiff({ ...SEP, joinStr: null, lastWorkDayStr: null, leaveDates: ['2026-09-03', '2026-09-03'], rosterMinutes: 29 * 9 * 60 })
    assert.equal(r.expectedMinutes, 29 * 9 * 60)
  })
})
