/**
 * ★ cw-lanes-20260821-a2: 重疊預約橫向分欄（layoutBookings）純邏輯測試
 * Spec: 拍板①（MAX_LANES=3 + 「+N」）/ 拍板⑤（剷舊掃描線合併，逐筆回）；MD §3.2 §6.3
 * 跑法: cd apps/web && npx tsx --test src/lib/provider-availability-layout.test.ts
 * Node 22 內建 test runner（node:test），唔加新 dependency（照 provider-availability-view.test.ts 慣例）。
 *
 * 驗收對照（MD §6.3）：
 *  - #11 兩個重疊 → 各佔 ½（lanes=2）
 *  - #12 三個重疊 → 各佔 ⅓（lanes=3）
 *  - #13 四個以上 → 3 placed + overflow（「+N」窄條）
 *  - #14 19:00–19:30 同 19:30–20:00 = 連續唔重疊 → 各佔全闊（★★★ 最易錯）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { layoutBookings, type Positioned } from './provider-availability-view'

/** fixture：一支預約（s/e = 分鐘數，00:00 起） */
function B(s: number, e: number, over: Partial<{ s: number; e: number; status: number; providerId: string; name: string; color: string }> = {}) {
  return { s, e, status: 0, providerId: 'p1', name: 'Dr Test', color: '#000000', ...over }
}

describe('layoutBookings — 重疊橫向分欄（MD §3.2）', () => {
  it('#14 ★★★ 連續唔重疊（09:00–09:30 + 09:30–10:00）→ 兩個獨立 cluster，各 lanes=1 全闊', () => {
    const out = layoutBookings([B(540, 570), B(570, 600)])
    assert.equal(out.length, 2)
    assert.deepEqual(
      out.map(o => [o.s, o.e, o.lane, o.lanes, o.overflow]),
      [[540, 570, 0, 1, 0], [570, 600, 0, 1, 0]],
    )
  })

  it('#14 延伸：三筆連續接力（09:00–09:30 / 09:30–10:00 / 10:00–10:30）→ 三個獨立 cluster', () => {
    const out = layoutBookings([B(540, 570), B(570, 600), B(600, 630)])
    assert.equal(out.length, 3)
    for (const o of out) {
      assert.equal(o.lane, 0)
      assert.equal(o.lanes, 1)
      assert.equal(o.overflow, 0)
    }
  })

  it('#11 兩個重疊 → 各佔 ½（lanes=2）', () => {
    const out = layoutBookings([B(540, 600, { providerId: 'p1', name: 'A' }), B(555, 615, { providerId: 'p2', name: 'B' })])
    assert.equal(out.length, 2)
    assert.deepEqual(
      out.map(o => [o.s, o.lanes]),
      [[540, 2], [555, 2]],
    )
    const lanes = out.map(o => o.lane).sort()
    assert.deepEqual(lanes, [0, 1])
  })

  it('#12 三個重疊 → 各佔 ⅓（lanes=3）', () => {
    const out = layoutBookings([B(540, 660), B(555, 675), B(570, 690)])
    assert.equal(out.length, 3)
    for (const o of out) assert.equal(o.lanes, 3)
    assert.deepEqual(out.map(o => o.lane).sort(), [0, 1, 2])
    for (const o of out) assert.equal(o.overflow, 0)
  })

  it('#13 四個重疊 → 3 個 placed + overflow=1（cluster 共用，每個 placed 同數）', () => {
    const out = layoutBookings([B(540, 660), B(555, 675), B(570, 690), B(585, 705)])
    assert.equal(out.length, 3, '第 4 筆唔入 out（由前端「+N」窄條標示）')
    for (const o of out) {
      assert.equal(o.overflow, 1, 'cluster 內每個 placed item 都帶同一個 overflow')
      assert.equal(o.lanes, 3)
    }
    assert.deepEqual(out.map(o => o.lane).sort(), [0, 1, 2])
  })

  it('#13 延伸：五個重疊 → 3 placed + overflow=2；獨立嘅第 6 筆唔計入 overflow', () => {
    const out = layoutBookings([B(540, 660), B(555, 675), B(570, 690), B(585, 705), B(600, 720), B(900, 930)])
    const cluster = out.filter(o => o.s < 800)
    assert.equal(cluster.length, 3)
    for (const o of cluster) assert.equal(o.overflow, 2)
    const solo = out.find(o => o.s === 900)!
    assert.equal(solo.overflow, 0)
    assert.equal(solo.lanes, 1)
  })

  it('lane 重用：[09:00–09:30, 09:30–10:00, 09:15–09:45] → 第三筆（09:15–09:45）唔搶第一條 lane', () => {
    const a = B(540, 570, { providerId: 'pa', name: 'A' })
    const b = B(570, 600, { providerId: 'pb', name: 'B' })
    const c = B(555, 585, { providerId: 'pc', name: 'C' })
    const out = layoutBookings([a, b, c])
    // 排好序後：A(540–570) → lane0；C(555–585) 重疊 A → lane1；B(570–600) 570<=570 → 重用 lane0
    assert.equal(out.length, 3)
    const byS = new Map(out.map(o => [o.s, o]))
    assert.equal(byS.get(540)!.lane, 0)
    assert.equal(byS.get(555)!.lane, 1, '第三筆（09:15–09:45）唔搶第一條 lane')
    assert.equal(byS.get(570)!.lane, 0, '09:30–10:00 重用 lane0（09:30 啱啱有得收）')
    for (const o of out) assert.equal(o.lanes, 2)
  })

  it('包含關係：一支包埋另外兩支 → 三支各佔一 lane', () => {
    const out = layoutBookings([B(570, 600), B(540, 660), B(585, 615)])
    assert.equal(out.length, 3)
    for (const o of out) assert.equal(o.lanes, 3)
    assert.deepEqual(out.map(o => o.lane).sort(), [0, 1, 2])
  })

  it('亂序輸入 → 輸出排序（s → e）且 lane 分配同排序後一致', () => {
    const shuffled = [B(570, 600), B(540, 570)]
    const out = layoutBookings(shuffled)
    assert.deepEqual(
      out.map(o => [o.s, o.e]),
      [[540, 570], [570, 600]],
    )
    // 重疊 cluster 亂序入 → 結果同順序入一致
    const o1 = layoutBookings([B(540, 660), B(555, 675), B(570, 690)])
    const o2 = layoutBookings([B(570, 690), B(555, 675), B(540, 660)])
    assert.deepEqual(
      o2.map(o => [o.s, o.e, o.lanes, o.overflow]),
      o1.map(o => [o.s, o.e, o.lanes, o.overflow]),
    )
  })

  it('0 筆 → 空 array', () => {
    assert.deepEqual(layoutBookings([]), [])
  })

  it('1 筆 → lane=0 lanes=1 overflow=0（全闊）', () => {
    const out = layoutBookings([B(540, 570, { providerId: 'p9', name: 'Solo', status: 4, color: '#ABCDEF' })])
    assert.equal(out.length, 1)
    assert.deepEqual(out[0], { s: 540, e: 570, status: 4, providerId: 'p9', name: 'Solo', color: '#ABCDEF', lane: 0, lanes: 1, overflow: 0 })
  })

  it('唔會 mutate 輸入 array', () => {
    const input = [B(570, 600), B(540, 570)]
    layoutBookings(input)
    assert.deepEqual(input.map(o => [o.s, o.e]), [[570, 600], [540, 570]])
  })

  it('輸出係 Positioned（帶齊 lane/lanes/overflow + 原字段）', () => {
    const out: Positioned[] = layoutBookings([B(540, 600), B(555, 615)])
    for (const o of out) {
      assert.equal(typeof o.lane, 'number')
      assert.equal(typeof o.lanes, 'number')
      assert.equal(typeof o.overflow, 'number')
      assert.equal(typeof o.status, 'number')
      assert.equal(typeof o.providerId, 'string')
      assert.equal(typeof o.name, 'string')
      assert.equal(typeof o.color, 'string')
    }
  })
})
