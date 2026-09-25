/**
 * cwi-final S5-7（W-8）：ACTIVE_BOOKING_STATUSES = [0, 1, 102]（T815）
 *
 * 1 = 已到診（Arrived）— 病人已到店、位仍佔住：
 *   - workforce bookable-slots（hold 前查 clash）要計佢
 *   - availability cache 佔用口徑（黑名單 RELEASED {4,-3,-6,-7}）本來就計佢 — 两边要一致
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVE_BOOKING_STATUSES } from '../bookable-slots-service'
import { buildSlotGrid } from './sync-availability-cache'
import type { OpenSchRow, BookingRow } from './availability'

const DATE = '2026-09-01'
const openSches: OpenSchRow[] = [{ date: DATE, startTime: '09:00', endTime: '10:00' }]

describe('T815 S5-7：ACTIVE_BOOKING_STATUSES + availability 佔用口徑', () => {
  it('ACTIVE_BOOKING_STATUSES = [0, 1, 102]（Pending + Arrived + Reschedule-Hold）', () => {
    assert.deepEqual([...ACTIVE_BOOKING_STATUSES], [0, 1, 102])
  })

  it('status 1（Arrived）= 佔用 — buildSlotGrid bookedCount 計入', () => {
    const rows = buildSlotGrid(openSches, [
      { date: DATE, startMin: 540, endMin: 570, status: 1 }, // 09:00–09:30 已到診
    ])
    assert.equal(rows.length, 2)
    assert.equal(rows[0].bookedCount, 1, '09:00 格：Arrived 計佔用')
    assert.equal(rows[1].bookedCount, 0)
  })

  it('status 0（已約）/ 102（改期 hold）都佔用；RELEASED（4/-7）唔佔', () => {
    const rows = buildSlotGrid(openSches, [
      { date: DATE, startMin: 540, endMin: 570, status: 0 },
      { date: DATE, startMin: 570, endMin: 600, status: 102 },
    ])
    assert.equal(rows[0].bookedCount, 1)
    assert.equal(rows[1].bookedCount, 1)

    const released = buildSlotGrid(openSches, [
      { date: DATE, startMin: 540, endMin: 570, status: 4 },
      { date: DATE, startMin: 570, endMin: 600, status: -7 },
    ])
    assert.equal(released[0].bookedCount, 0)
    assert.equal(released[1].bookedCount, 0)
  })
})
