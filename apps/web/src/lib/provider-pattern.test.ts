/**
 * ★ cw-patwl-20260822-a1: 醫生當值表 pattern 純邏輯測試
 * 跑法: cd apps/web && npx tsx --test src/lib/provider-pattern.test.ts
 *
 * 覆蓋：
 * - resolveSlots：預設 / 自訂 / 部分 / 壞 JSON（try/catch 唔爆頁）
 * - resolveOnDuty 三層疊：pattern → shift 覆蓋（含 OFF）→ leave 蓋走
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SLOTS, resolveSlots, resolveOnDuty } from './provider-pattern'

// 2026-08-22 = 六 → 參考日：
//   2026-08-23 日(0) / 2026-08-24 一(1) / 2026-08-25 二(2) / 2026-08-30 日(0)
const SUN = '2026-08-23'
const MON = '2026-08-24'
const TUE = '2026-08-25'
const SUN_NEXT = '2026-08-30'

describe('resolveSlots — Clinic.config.providerSlots 解析', () => {
  it('null / 空 config → DEFAULT_SLOTS', () => {
    assert.deepEqual(resolveSlots(null), DEFAULT_SLOTS)
    assert.deepEqual(resolveSlots('{}'), DEFAULT_SLOTS)
  })

  it('冇 providerSlots key → DEFAULT_SLOTS', () => {
    assert.deepEqual(resolveSlots(JSON.stringify({ somethingElse: 1 })), DEFAULT_SLOTS)
  })

  it('全自訂 → 用自訂', () => {
    const cfg = {
      providerSlots: {
        FULL: { start: '09:00', end: '18:00' },
        AM: { start: '09:00', end: '12:30' },
        PM: { start: '13:30', end: '18:00' },
      },
    }
    const s = resolveSlots(JSON.stringify(cfg))
    assert.deepEqual(s.FULL, { start: '09:00', end: '18:00' })
    assert.deepEqual(s.AM, { start: '09:00', end: '12:30' })
    assert.deepEqual(s.PM, { start: '13:30', end: '18:00' })
  })

  it('部分自訂（只有 AM）→ 其餘 fallback 預設', () => {
    const cfg = { providerSlots: { AM: { start: '08:00', end: '11:00' } } }
    const s = resolveSlots(JSON.stringify(cfg))
    assert.deepEqual(s.AM, { start: '08:00', end: '11:00' })
    assert.deepEqual(s.FULL, DEFAULT_SLOTS.FULL)
    assert.deepEqual(s.PM, DEFAULT_SLOTS.PM)
  })

  it('壞 JSON → 預設（唔會 throw —— 驗收 #14）', () => {
    assert.deepEqual(resolveSlots('not-json{'), DEFAULT_SLOTS)
    assert.deepEqual(resolveSlots('null'), DEFAULT_SLOTS)
    assert.deepEqual(resolveSlots('"[1,2,3]"'), DEFAULT_SLOTS) // providerSlots 唔係 object
  })
})

describe('resolveOnDuty — 三層疊（pattern → shift → leave）', () => {
  const p1 = { providerId: 'p1', weekday: 2, slot: 'FULL' } // 星期二
  const p2 = { providerId: 'p2', weekday: 0, slot: 'PM' }   // 星期日

  it('① pattern only：匹配 weekday 先有佢（驗收 #9）', () => {
    const onTue = resolveOnDuty(TUE, [p1, p2], [], new Set())
    assert.deepEqual([...onTue.keys()], ['p1'])
    assert.equal(onTue.get('p1')?.slot, 'FULL')
    assert.equal(onTue.get('p1')?.isException, false)

    const onMon = resolveOnDuty(MON, [p1, p2], [], new Set())
    assert.equal(onMon.size, 0)

    const onSun = resolveOnDuty(SUN, [p1, p2], [], new Set())
    assert.deepEqual([...onSun.keys()], ['p2'])
    // 星期日 pattern 下週同一 pattern（weekly 循環）
    assert.deepEqual([...resolveOnDuty(SUN_NEXT, [p1, p2], [], new Set()).keys()], ['p2'])
  })

  it('② shift 例外覆蓋 pattern slot（驗收 #10）', () => {
    const shifts = [{ providerId: 'p1', date: TUE, slot: 'AM' }]
    const m = resolveOnDuty(TUE, [p1], shifts, new Set())
    assert.equal(m.get('p1')?.slot, 'AM')
    assert.equal(m.get('p1')?.isException, true)
  })

  it('② shift slot=null → 當 FULL（用 startTime/endTime 語義）', () => {
    const shifts = [{ providerId: 'p9', date: TUE, slot: null }]
    const m = resolveOnDuty(TUE, [], shifts, new Set())
    assert.equal(m.get('p9')?.slot, 'FULL')
    assert.equal(m.get('p9')?.isException, true)
  })

  it('② shift 可以加 pattern 冇嘅醫生（臨時頂更）', () => {
    const m = resolveOnDuty(TUE, [p1], [{ providerId: 'p3', date: TUE, slot: 'PM' }], new Set())
    assert.deepEqual([...m.keys()].sort(), ['p1', 'p3'])
  })

  it("② slot='OFF' → 當日唔返（覆蓋 pattern，唔計當值；驗收 #12）", () => {
    const m = resolveOnDuty(TUE, [p1], [{ providerId: 'p1', date: TUE, slot: 'OFF' }], new Set())
    assert.equal(m.size, 0)
  })

  it("② OFF 對 pattern 冇嘅醫生 = no-op（唔會加人）", () => {
    const m = resolveOnDuty(TUE, [p1], [{ providerId: 'pX', date: TUE, slot: 'OFF' }], new Set())
    assert.deepEqual([...m.keys()], ['p1'])
  })

  it('② 唔係該日嘅 shift row 唔會理', () => {
    const m = resolveOnDuty(TUE, [p1], [{ providerId: 'p1', date: MON, slot: 'OFF' }], new Set())
    assert.deepEqual([...m.keys()], ['p1'])
  })

  it('③ leave 蓋走 pattern（驗收 #11）', () => {
    const leaves = new Set([`p1:${TUE}`])
    const m = resolveOnDuty(TUE, [p1], [], leaves)
    assert.equal(m.size, 0)
  })

  it('③ leave 蓋走 shift 例外', () => {
    const leaves = new Set([`p1:${TUE}`])
    const m = resolveOnDuty(TUE, [], [{ providerId: 'p1', date: TUE, slot: 'FULL' }], leaves)
    assert.equal(m.size, 0)
  })

  it('③ 其他日嘅 leave 唔會理', () => {
    const leaves = new Set([`p1:${MON}`])
    const m = resolveOnDuty(TUE, [p1], [], leaves)
    assert.deepEqual([...m.keys()], ['p1'])
  })

  it('疊完整場景：p1 二 FULL（假）＋ p2 二 AM（頂更）＋ p3 二 PM → 淨返 p2/p3', () => {
    const patterns = [
      { providerId: 'p1', weekday: 2, slot: 'FULL' },
      { providerId: 'p2', weekday: 2, slot: 'AM' },
    ]
    const shifts = [{ providerId: 'p3', date: TUE, slot: 'PM' }]
    const leaves = new Set([`p1:${TUE}`])
    const m = resolveOnDuty(TUE, patterns, shifts, leaves)
    assert.deepEqual([...m.keys()].sort(), ['p2', 'p3'])
  })
})
