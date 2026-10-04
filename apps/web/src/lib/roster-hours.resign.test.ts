/**
 * ★ cwm-resigntb-20261004：離職結算預先計當月編更差額 —— lastWorkDay 覆寫＋最後工作日之後嘅更唔計
 * 跑法: TZ=UTC npx tsx --test src/lib/roster-hours.resign.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeRosterHours } from './roster-hours'

// 每日 10:00–18:30（跨度 8.5h，扣 60 分午飯 = 7.5h 淨）
const shift = (d: string) => ({
  employeeId: 'e1', status: 'CONFIRMED', template: { deductLunch: true },
  date: new Date(`${d}T00:00:00+08:00`),
  startTime: new Date(`${d}T10:00:00+08:00`), endTime: new Date(`${d}T18:30:00+08:00`),
})
const db = (resignedAt: Date | null) => ({
  employee: { findMany: async () => [{ id: 'e1', joinDate: new Date('2025-01-01T00:00:00+08:00'), resignedAt }] },
  leaveRequest: { findMany: async () => [] },
  shift: { findMany: async () => ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05'].map(shift) },
  payRule: { findMany: async () => [{ employeeId: 'e1', configJson: '{}' }] },
})

describe('computeRosterHours：離職最後工作日', () => {
  it('lastWorkDay 覆寫：應返同已編班都只計到最後工作日（之後未取消嘅更唔計）', async () => {
    const r = (await computeRosterHours(['e1'], '2026-10', db(null), { lastWorkDay: new Map([['e1', '2026-10-02']]) })).get('e1')!
    assert.equal(r.expectedMinutes, 2 * 9 * 60)
    assert.equal(r.rosterMinutes, 2 * 450)
    assert.equal(r.diffMinutes, 900 - 1080)
  })
  it('DB 已有 resignedAt（確認離職後）同覆寫結果一樣', async () => {
    const viaDb = (await computeRosterHours(['e1'], '2026-10', db(new Date('2026-10-03T00:00:00+08:00')))).get('e1')!
    assert.equal(viaDb.diffMinutes, -180)
  })
  it('在職員工：成個月計（唔受影響）', async () => {
    const r = (await computeRosterHours(['e1'], '2026-10', db(null))).get('e1')!
    assert.equal(r.rosterMinutes, 4 * 450)
  })
})
