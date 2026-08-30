/**
 * ★ providerslot-20260830 T2: 四態格純邏輯測試
 * 跑法: cd apps/web && npx tsx --test src/lib/provider-availability-grid.test.ts
 * Node 22 內建 test runner（node:test）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  gridCellState,
  gridCellStyle,
  gridWeekEmpty,
  computeGridAxis,
  GRID_COLORS,
  type GridSlot,
  type GridResp,
} from './provider-availability-view'

/** 造 48 格 default（全 outside_open）+ 覆蓋指定格 */
function mkSlots(overrides: Partial<GridSlot> & { i: number }[]): GridSlot[] {
  const base = Array.from({ length: 48 }, (_, i): GridSlot => ({
    i,
    start: `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
    end: `${String(Math.floor((i + 1) / 2) % 24).padStart(2, '0')}:${(i + 1) % 2 ? '30' : '00'}`,
    status: 'outside_open',
    seatsFree: 0,
    occ: null,
    frag: [0, 0],
    holds: [],
  }))
  for (const o of overrides) {
    base[o.i] = { ...base[o.i], ...o } as GridSlot
  }
  return base
}

describe('gridCellState — 四態映射（MD §六）', () => {
  it('offerable → 實心綠「線上可出 · N 席」', () => {
    const r = gridCellState({ i: 12, start: '06:00', end: '06:30', status: 'offerable', seatsFree: 2, occ: [1, 0], frag: [0, 0], holds: [] })
    assert.equal(r.state, 'offerable')
    assert.equal(r.label, '線上可出 · 2 席')
    assert.equal(r.closedKind, null)
  })

  it('hold 覆蓋（holds.length>0）→ 橙邊「線上已佔」— 優先於 offerable/over_capacity', () => {
    const hold = { s: '08:00', e: '08:30', src: 'whatsapp_flow', st: 'HELD', at: '2026-08-30T00:10:00.000Z' }
    const r1 = gridCellState({ i: 16, start: '08:00', end: '08:30', status: 'offerable', seatsFree: 3, occ: [0, 0], frag: [0, 0], holds: [hold] })
    assert.equal(r1.state, 'held')
    assert.equal(r1.label, '線上已佔')
    // held_overlap status（T1 evaluateDay 判定）→ 橙邊
    const r2 = gridCellState({ i: 16, start: '08:00', end: '08:30', status: 'held_overlap', seatsFree: 0, occ: [1, 1], frag: [0, 0], holds: [] })
    assert.equal(r2.state, 'held')
  })

  it('over_capacity + 碎片 → 虛邊綠「只人手 · N × 15 分」', () => {
    const r1 = gridCellState({ i: 18, start: '09:00', end: '09:30', status: 'over_capacity', seatsFree: 0, occ: [3, 2], frag: [0, 1], holds: [] })
    assert.equal(r1.state, 'fragment')
    assert.equal(r1.label, '只人手 · 1 × 15 分')
    assert.equal(r1.fragCount, 1)
    const r2 = gridCellState({ i: 18, start: '09:00', end: '09:30', status: 'over_capacity', seatsFree: 0, occ: [2, 2], frag: [1, 1], holds: [] })
    assert.equal(r2.label, '只人手 · 2 × 15 分')
  })

  it('over_capacity 無碎片 → 灰「滿」', () => {
    const r = gridCellState({ i: 18, start: '09:00', end: '09:30', status: 'over_capacity', seatsFree: 0, occ: [3, 3], frag: [0, 0], holds: [] })
    assert.equal(r.state, 'closed')
    assert.equal(r.label, '滿')
    assert.equal(r.closedKind, 'full')
  })

  it('on_leave → 灰「休假」；lead_time → 灰「未開診」（線上未開）；outside_open → 灰「未開診」', () => {
    assert.equal(gridCellState({ ...mkSlots([])[0], status: 'on_leave' }).closedKind, 'on_leave')
    assert.equal(gridCellState({ ...mkSlots([])[0], status: 'on_leave' }).label, '休假')
    assert.equal(gridCellState({ ...mkSlots([])[0], status: 'lead_time' }).closedKind, 'lead_time')
    assert.equal(gridCellState({ ...mkSlots([])[0], status: 'outside_open' }).label, '未開診')
  })
})

describe('gridCellStyle — 3a 顏色 spec', () => {
  it('四態各返正確背景/邊框', () => {
    assert.equal(gridCellStyle('offerable').background, GRID_COLORS.offerable)
    assert.equal(gridCellStyle('offerable').border, 'none')
    assert.equal(gridCellStyle('fragment').border, `1.5px dashed ${GRID_COLORS.fragmentBorder}`)
    assert.equal(gridCellStyle('held').border, `1.5px solid ${GRID_COLORS.heldBorder}`)
    assert.equal(gridCellStyle('closed').background, GRID_COLORS.closedBg)
  })
})

describe('gridWeekEmpty / computeGridAxis', () => {
  function mkResp(days: { date: string; slots: GridSlot[] }[]): GridResp {
    return {
      clinic: { id: 'c1', name: 'T' },
      from: days[0].date, to: days[days.length - 1].date,
      capacity: 3, leadTimeMin: 30, generatedAt: '',
      sync: { lastSyncAt: null, stale: true },
      dayFlags: days.map(d => ({ date: d.date, onDutyCount: 1, hasPattern: false })),
      providers: [{
        id: 'p1', name: 'D', color: null, weekBookings: 0, leaveDates: [],
        days: days.map(d => ({ date: d.date, precise: true, bookCount: 0, slots: d.slots })),
      }],
    }
  }
  const D1 = '2026-08-30'
  const D2 = '2026-08-31'

  it('全空（slots=[] = 無數據）→ weekEmpty true；有 offerable 格 → false', () => {
    assert.equal(gridWeekEmpty(mkResp([{ date: D1, slots: [] }, { date: D2, slots: [] }])), true)
    assert.equal(gridWeekEmpty(mkResp([{ date: D1, slots: mkSlots([]) }, { date: D2, slots: [] }])), false)
  })

  it('有 leaveDates 都算有內容 → false', () => {
    const r = mkResp([{ date: D1, slots: [] }, { date: D2, slots: [] }])
    r.providers[0].leaveDates = [D1]
    assert.equal(gridWeekEmpty(r), false)
  })

  it('軸 = 非 outside_open 格 floor/ceil 整點，保底 09:00–21:00', () => {
    // 10:00–13:30 開診 → 軸 10:00–14:00，但保底 09:00–21:00
    const r = mkResp([{
      date: D1, slots: mkSlots([
        { i: 20, status: 'offerable', seatsFree: 3 },
        { i: 21, status: 'over_capacity' },
        { i: 22, status: 'lead_time' },
        { i: 26, status: 'offerable', seatsFree: 1 },
      ] as any),
    }])
    assert.deepEqual(computeGridAxis(r), [9 * 60, 21 * 60])

    // 08:00 開 → 480（保底唔係封頂）
    const r2 = mkResp([{ date: D1, slots: mkSlots([{ i: 16, status: 'offerable', seatsFree: 3 }] as any) }])
    assert.deepEqual(computeGridAxis(r2), [8 * 60, 21 * 60])
  })

  it('全 outside_open（有數據但無開診時段）→ fallback 09:00–21:00', () => {
    assert.deepEqual(computeGridAxis(mkResp([{ date: D1, slots: mkSlots([]) }])), [9 * 60, 21 * 60])
  })
})
