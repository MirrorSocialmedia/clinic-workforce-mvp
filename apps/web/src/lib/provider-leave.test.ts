/**
 * ★ cw-pta: 醫生休假日期展開純邏輯測試
 * 跑法: cd apps/web && npx tsx --test src/lib/provider-leave.test.ts
 *
 * ProviderLeave startDate/endDate 都係 HK 午夜（endDate 包入當日，
 * provider-leaves POST 用 hkDateStart(endDate) 存）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { expandLeavesToSet, type LeaveRow } from './provider-leave'

/** 'YYYY-MM-DD' HK 午夜（+08:00） */
const hk = (d: string) => new Date(`${d}T00:00:00+08:00`)

const leave = (providerId: string, startDate: string, endDate: string): LeaveRow => ({
  providerId,
  startDate: hk(startDate),
  endDate: hk(endDate),
})

describe('expandLeavesToSet — leaveSet 展開 `${providerId}:${HKdate}`', () => {
  it('跨日休假（8/22–8/24）→ 三日都包入（兩端包入；spec §6.3 #17 同源場景）', () => {
    const s = expandLeavesToSet([leave('p1', '2026-08-22', '2026-08-24')])
    assert.deepEqual(
      [...s].sort(),
      ['p1:2026-08-22', 'p1:2026-08-23', 'p1:2026-08-24'],
    )
  })

  it('單日假（start==end）→ 只有 1 日', () => {
    const s = expandLeavesToSet([leave('p1', '2026-08-22', '2026-08-22')])
    assert.deepEqual([...s], ['p1:2026-08-22'])
  })

  it('唔同醫生嘅假分開存（key 含 providerId）', () => {
    const s = expandLeavesToSet([
      leave('p1', '2026-08-22', '2026-08-22'),
      leave('p2', '2026-08-22', '2026-08-23'),
    ])
    assert.deepEqual(
      [...s].sort(),
      ['p1:2026-08-22', 'p2:2026-08-22', 'p2:2026-08-23'],
    )
  })

  it('同一醫生兩段假 → 合併入同一 Set（重複 key 唔會雙計）', () => {
    const s = expandLeavesToSet([
      leave('p1', '2026-08-22', '2026-08-23'),
      leave('p1', '2026-08-23', '2026-08-24'),
    ])
    assert.deepEqual(
      [...s].sort(),
      ['p1:2026-08-22', 'p1:2026-08-23', 'p1:2026-08-24'],
    )
  })

  it('跨月展開（8/30–9/2）', () => {
    const s = expandLeavesToSet([leave('p1', '2026-08-30', '2026-09-02')])
    assert.deepEqual(
      [...s].sort(),
      ['p1:2026-08-30', 'p1:2026-08-31', 'p1:2026-09-01', 'p1:2026-09-02'],
    )
  })

  it('空清單 → 空 Set', () => {
    assert.equal(expandLeavesToSet([]).size, 0)
  })
})
