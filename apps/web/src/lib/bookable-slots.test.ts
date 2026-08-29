// ★ providerslot-20260830 T1: 可約時段純邏輯 unit test（test-first 風格）
// 跑法: npx tsx --test src/lib/bookable-slots.test.ts
//
// 覆蓋 MD §一 全部 edge case：
//   - 10:30 反例（lane 檢查會錯殺 → concurrency max 檢查必須可出）
//   - 15 分鐘預約跨 :00/:30 邊
//   - leadTime 邊界（t = now+lead 可出；差一分鐘唔得）
//   - hold 覆蓋 / 相鄰 hold
//   - ProviderLeave
//   - capacity 1 / 2 / 3
//   - openSch 部分覆蓋 / 午休跨窗 / 無 openSch
//   - 碎片（fragment）定義（只 over_capacity 窗口先有；leadTime 唔算）
//   - buildTimeline / windowOfCell 單元
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateDay,
  buildTimeline,
  intervalCovered,
  anyOverlap,
  windowOfCell,
  hhmmToMin,
  minToHHmm,
  isHHmm,
  UNIT_MIN,
  type Interval,
  type DayEvalInput,
} from './bookable-slots'

const iv = (s: number, e: number): Interval => ({ startMin: s, endMin: e })
const H = (h: number, m: number) => h * 60 + m // 小時:分鐘 → 分鐘數

function day(input: Partial<DayEvalInput>): DayEvalInput {
  return {
    capacity: 3,
    onLeave: false,
    minStartMin: null,
    openSch: [iv(0, 1440)], // 全日開診（default；case 自行覆蓋）
    bookings: [],
    holds: [],
    ...input,
  }
}

/** 攞指定 startMin 嘅 slot eval */
function slotAt(evalr: ReturnType<typeof evaluateDay>, startMin: number) {
  const s = evalr.slots.find((x) => x.startMin === startMin)
  assert.ok(s, `slot ${startMin} 唔應該缺`)
  return s
}

// ─── buildTimeline ───────────────────────────────────────────────────

describe('buildTimeline — 15 分鐘格', () => {
  it('15m 預約 10:15–10:30 只計 10:15 格（MD 註：只令該 15 分鐘 +1）', () => {
    const t = buildTimeline([iv(H(10, 15), H(10, 30))])
    assert.equal(t[H(10, 15) / 15], 1)
    assert.equal(t[H(10, 0) / 15], 0)
    assert.equal(t[H(10, 30) / 15], 0)
    assert.equal(t.reduce((a, b) => a + b, 0), 1)
  })

  it('30m 預約 10:30–11:00 計 2 格', () => {
    const t = buildTimeline([iv(H(10, 30), H(11, 0))])
    assert.equal(t[H(10, 30) / 15], 1)
    assert.equal(t[H(10, 45) / 15], 1)
    assert.equal(t[H(11, 0) / 15], 0)
  })

  it('空 interval 集 → 全零；壞數據（end<=start）跳過', () => {
    assert.ok(buildTimeline([]).every((v) => v === 0))
    assert.ok(buildTimeline([iv(600, 600), iv(700, 500)]).every((v) => v === 0))
  })

  it('重疊預約逐格累計', () => {
    const t = buildTimeline([iv(H(9, 0), H(9, 30)), iv(H(9, 15), H(9, 45))])
    assert.equal(t[H(9, 0) / 15], 1)
    assert.equal(t[H(9, 15) / 15], 2)
    assert.equal(t[H(9, 30) / 15], 1)
  })
})

// ─── 小工具 ──────────────────────────────────────────────────────────

describe('工具函数', () => {
  it('hhmmToMin / minToHHmm round-trip', () => {
    assert.equal(hhmmToMin('09:30'), H(9, 30))
    assert.equal(minToHHmm(H(9, 30)), '09:30')
    assert.equal(minToHHmm(0), '00:00')
    assert.equal(minToHHmm(1439), '23:59')
  })

  it('isHHmm', () => {
    assert.ok(isHHmm('09:30'))
    assert.ok(!isHHmm('9:30'))
    assert.ok(!isHHmm('09:60'))
    assert.ok(!isHHmm('24:00'))
    assert.ok(!isHHmm('ab:cd'))
  })

  it('intervalCovered — 完全包含先 true', () => {
    assert.ok(intervalCovered([iv(H(9, 0), H(12, 30))], iv(H(9, 0), H(9, 30))))
    assert.ok(intervalCovered([iv(H(9, 0), H(12, 30))], iv(H(12, 0), H(12, 30))))
    assert.ok(!intervalCovered([iv(H(9, 0), H(12, 30))], iv(H(12, 30), H(13, 0))))
    assert.ok(!intervalCovered([iv(H(9, 0), H(12, 30))], iv(H(8, 30), H(9, 30))))
    // 兩個 interval 唔可以拼埋包一個窗口（午休跨窗）
    assert.ok(!intervalCovered([iv(H(9, 0), H(12, 0)), iv(H(13, 0), H(18, 0))], iv(H(11, 30), H(12, 0)) === iv(H(11, 30), H(12, 0)) ? iv(H(12, 30), H(13, 0)) : iv(H(11, 45), H(12, 15))))
    assert.ok(!intervalCovered([iv(H(9, 0), H(12, 0)), iv(H(13, 0), H(18, 0))], iv(H(11, 45), H(12, 15))))
    assert.ok(intervalCovered([iv(H(9, 0), H(12, 0)), iv(H(13, 0), H(18, 0))], iv(H(13, 0), H(13, 30))))
  })

  it('anyOverlap — 端點相接唔算重疊（[a,b) 半開區間）', () => {
    assert.ok(anyOverlap([iv(H(10, 0), H(10, 30))], iv(H(10, 0), H(10, 30))))
    assert.ok(anyOverlap([iv(H(10, 15), H(10, 45))], iv(H(10, 0), H(10, 30))))
    assert.ok(!anyOverlap([iv(H(10, 30), H(11, 0))], iv(H(10, 0), H(10, 30))))
  })

  it('windowOfCell — floor 語義：格屬「起點 ≤ 格起」嘅 30m 窗', () => {
    assert.deepEqual(windowOfCell(H(10, 0)), iv(H(10, 0), H(10, 30)))
    assert.deepEqual(windowOfCell(H(10, 30)), iv(H(10, 30), H(11, 0)))
    assert.deepEqual(windowOfCell(H(10, 45)), iv(H(10, 30), H(11, 0)))
    assert.deepEqual(windowOfCell(H(11, 15)), iv(H(11, 0), H(11, 30)))
  })
})

// ─── MD §一 10:30 反例（核心）────────────────────────────────────────

describe('MD §一 10:30 反例 — lane 檢查會錯殺', () => {
  it('兩批各 2 人（10:30–10:45 / 10:45–11:00）max=2 ≤ 2 → 可出，seatsFree=1', () => {
    const evalr = evaluateDay(day({
      capacity: 3,
      bookings: [
        iv(H(10, 30), H(10, 45)),
        iv(H(10, 30), H(10, 45)),
        iv(H(10, 45), H(11, 0)),
        iv(H(10, 45), H(11, 0)),
      ],
    }))
    const s = slotAt(evalr, H(10, 30))
    assert.equal(s.status, 'offerable') // ★ 反例核心：lane 檢查會判不可出
    assert.equal(s.maxBookings, 2)
    assert.equal(s.seatsFree, 1)
    assert.equal(evalr.offerable.length, 48) // 全日 48 窗都出（只有 10:30 有 2 人）
    assert.equal(slotAt(evalr, H(10, 0)).seatsFree, 3)
  })

  it('capacity 3 塞晒（3 人同時 15m）→ over_capacity', () => {
    const evalr = evaluateDay(day({
      capacity: 3,
      bookings: [
        iv(H(10, 30), H(10, 45)),
        iv(H(10, 30), H(10, 45)),
        iv(H(10, 30), H(10, 45)),
      ],
    }))
    const s = slotAt(evalr, H(10, 30))
    assert.equal(s.status, 'over_capacity')
    assert.equal(s.maxBookings, 3)
    assert.equal(s.seatsFree, 0)
  })
})

// ─── 條件 ① openSch ──────────────────────────────────────────────────

describe('條件 ① — W 完全落 openSch（扣午休）', () => {
  it('openSch 09:30–12:30：窗起/止對齊 openSch 可出；跨出就唔得', () => {
    const evalr = evaluateDay(day({ openSch: [iv(H(9, 30), H(12, 30))] }))
    assert.equal(slotAt(evalr, H(9, 30)).status, 'offerable')
    assert.equal(slotAt(evalr, H(12, 0)).status, 'offerable')
    assert.equal(slotAt(evalr, H(9, 0)).status, 'outside_open') // 早咗
    assert.equal(slotAt(evalr, H(12, 30)).status, 'outside_open') // 遲咗
  })

  it('09:30–12:30 內 30m 對齊窗 = 09:30/10:00/10:30/11:00/11:30/12:00 = 6 個', () => {
    const evalr = evaluateDay(day({ openSch: [iv(H(9, 30), H(12, 30))] }))
    assert.equal(evalr.offerable.length, 6)
    assert.deepEqual(
      evalr.offerable.map((s) => s.startMin),
      [H(9, 30), H(10, 0), H(10, 30), H(11, 0), H(11, 30), H(12, 0)],
    )
  })

  it('午休跨窗：11:30–12:00 跨 12:00–13:00 午休 → outside_open', () => {
    const evalr = evaluateDay(day({ openSch: [iv(H(9, 0), H(12, 0)), iv(H(13, 0), H(18, 0))] }))
    assert.equal(slotAt(evalr, H(11, 30)).status, 'offerable') // 11:30–12:00 完全喺朝早段
    assert.equal(slotAt(evalr, H(12, 0)).status, 'outside_open') // 12:00–12:30 喺午休
    assert.equal(slotAt(evalr, H(12, 30)).status, 'outside_open')
    assert.equal(slotAt(evalr, H(13, 0)).status, 'offerable')
  })

  it('無 openSch 行 → 全日 outside_open（0 slots）', () => {
    const evalr = evaluateDay(day({ openSch: [] }))
    assert.equal(evalr.offerable.length, 0)
    assert.ok(evalr.slots.every((s) => s.status === 'outside_open'))
  })
})

// ─── 條件 ④ leadTime ─────────────────────────────────────────────────

describe('條件 ④ — t ≥ now + leadTimeMin（邊界）', () => {
  it('minStartMin=10:00 → 09:30 唔得，10:00 得（≥ 邊界包含）', () => {
    const evalr = evaluateDay(day({ minStartMin: H(10, 0) }))
    assert.equal(slotAt(evalr, H(9, 30)).status, 'lead_time')
    assert.equal(slotAt(evalr, H(10, 0)).status, 'offerable')
    assert.equal(slotAt(evalr, H(10, 30)).status, 'offerable')
  })

  it('minStartMin=null（非今日）→ 無約束', () => {
    const evalr = evaluateDay(day({ minStartMin: null }))
    assert.equal(slotAt(evalr, 0).status, 'offerable')
  })

  it('minStartMin 越過全日（leadTime 太長）→ 全日 lead_time', () => {
    const evalr = evaluateDay(day({ minStartMin: 1500 }))
    assert.ok(evalr.slots.every((s) => s.status === 'lead_time'))
  })

  it('leadTime 同 openSch 邊界同時卡：openSch 起 10:00 + minStart 10:30 → 10:00 窗 lead_time', () => {
    const evalr = evaluateDay(day({ openSch: [iv(H(10, 0), H(12, 0))], minStartMin: H(10, 30) }))
    assert.equal(slotAt(evalr, H(10, 0)).status, 'lead_time')
    assert.equal(slotAt(evalr, H(10, 30)).status, 'offerable')
  })
})

// ─── 條件 ⑤ ProviderHold ─────────────────────────────────────────────

describe('條件 ⑤ — 無 ProviderHold 覆蓋 W', () => {
  it('hold 喺同 slot → held_overlap；相鄰 slot 唔受影響', () => {
    const evalr = evaluateDay(day({ holds: [iv(H(16, 0), H(16, 30))] }))
    assert.equal(slotAt(evalr, H(16, 0)).status, 'held_overlap')
    assert.equal(slotAt(evalr, H(16, 30)).status, 'offerable')
    assert.equal(slotAt(evalr, H(15, 30)).status, 'offerable')
    // maxOccupancy 要計住 hold（seatsFree 語義）
    assert.equal(slotAt(evalr, H(16, 0)).maxOccupancy, 1)
    assert.equal(slotAt(evalr, H(16, 0)).seatsFree, 0)
  })

  it('hold + 預約混合：1 booking + hold 喺同窗 → held_overlap（booking 先唔夠殺位）', () => {
    const evalr = evaluateDay(day({
      bookings: [iv(H(16, 0), H(16, 15))],
      holds: [iv(H(16, 0), H(16, 30))],
    }))
    const s = slotAt(evalr, H(16, 0))
    assert.equal(s.status, 'held_overlap')
    assert.equal(s.maxOccupancy, 2)
  })
})

// ─── 條件 ③ ProviderLeave ────────────────────────────────────────────

describe('條件 ③ — ProviderLeave', () => {
  it('onLeave → 全日 on_leave（就算有 openSch 空位）', () => {
    const evalr = evaluateDay(day({ onLeave: true }))
    assert.equal(evalr.offerable.length, 0)
    assert.ok(evalr.slots.every((s) => s.status === 'on_leave'))
  })
})

// ─── capacity 1 / 2 / 3 ──────────────────────────────────────────────

describe('capacity 邊界', () => {
  it('capacity=1：任何 1 筆預約喺窗內 → 唔出；空窗 seatsFree=1', () => {
    const evalr = evaluateDay(day({ capacity: 1, bookings: [iv(H(10, 15), H(10, 30))] }))
    assert.equal(slotAt(evalr, H(10, 0)).status, 'over_capacity')
    assert.equal(slotAt(evalr, H(10, 0)).maxBookings, 1)
    assert.equal(slotAt(evalr, H(10, 30)).status, 'offerable') // 10:30–11:00 冇預約
    assert.equal(slotAt(evalr, H(10, 30)).seatsFree, 1)
  })

  it('capacity=2：2 人同時 → 唔出（要 ≤1）', () => {
    const evalr = evaluateDay(day({ capacity: 2, bookings: [iv(H(10, 0), H(10, 30)), iv(H(10, 0), H(10, 30))] }))
    assert.equal(slotAt(evalr, H(10, 0)).status, 'over_capacity')
    assert.equal(slotAt(evalr, H(10, 0)).maxBookings, 2)
  })

  it('capacity=3：2 人同時 → 出（seatsFree=1）— 同 10:30 反例同原理', () => {
    const evalr = evaluateDay(day({ capacity: 3, bookings: [iv(H(10, 0), H(10, 30)), iv(H(10, 0), H(10, 30))] }))
    assert.equal(slotAt(evalr, H(10, 0)).status, 'offerable')
    assert.equal(slotAt(evalr, H(10, 0)).seatsFree, 1)
  })

  it('capacity 唔係 ≥1 整數 → RangeError', () => {
    assert.throws(() => evaluateDay(day({ capacity: 0 })), RangeError)
    assert.throws(() => evaluateDay(day({ capacity: 2.5 })), RangeError)
  })
})

// ─── 15m 預約跨邊（MD 註：碎片容量損失小）────────────────────────────

describe('15 分鐘預約跨 :00/:30 邊', () => {
  it('10:45–11:00 預約：10:30 窗 max=1；11:00 窗 max=0（唔食下個窗）', () => {
    const evalr = evaluateDay(day({ bookings: [iv(H(10, 45), H(11, 0))] }))
    assert.equal(slotAt(evalr, H(10, 30)).maxBookings, 1)
    assert.equal(slotAt(evalr, H(10, 30)).status, 'offerable')
    assert.equal(slotAt(evalr, H(11, 0)).maxBookings, 0)
    assert.equal(slotAt(evalr, H(11, 0)).seatsFree, 3)
  })

  it('30m 預約 10:15–10:45（:15 起）跨兩個 30m 窗：兩邊 max 都 =1', () => {
    const evalr = evaluateDay(day({ bookings: [iv(H(10, 15), H(10, 45))] }))
    assert.equal(slotAt(evalr, H(10, 0)).maxBookings, 1)
    assert.equal(slotAt(evalr, H(10, 30)).maxBookings, 1)
    assert.equal(slotAt(evalr, H(10, 0)).status, 'offerable')
    assert.equal(slotAt(evalr, H(10, 30)).status, 'offerable')
  })

  it('45m 預約 10:00–10:45：10:00 窗 max=1、10:30 窗 max=1（唔係 2）', () => {
    const evalr = evaluateDay(day({ bookings: [iv(H(10, 0), H(10, 45))] }))
    assert.equal(slotAt(evalr, H(10, 0)).maxBookings, 1)
    assert.equal(slotAt(evalr, H(10, 30)).maxBookings, 1)
  })
})

// ─── 碎片（fragment）─────────────────────────────────────────────────

describe('碎片 — 15m 可插但 30m 窗唔出（UI 內部用）', () => {
  it('上半塞晒 3 人、下半有 1 人 → 下半 15m 格 = 碎片（seatsFree=2）', () => {
    const evalr = evaluateDay(day({
      capacity: 3,
      includeFragments: true,
      bookings: [
        iv(H(10, 30), H(10, 45)),
        iv(H(10, 30), H(10, 45)),
        iv(H(10, 30), H(10, 45)),
        iv(H(10, 45), H(11, 0)),
      ],
    }))
    assert.equal(slotAt(evalr, H(10, 30)).status, 'over_capacity')
    assert.equal(evalr.fragments.length, 1)
    assert.deepEqual(evalr.fragments[0], { startMin: H(10, 45), endMin: H(11, 0), seatsFree: 2 })
  })

  it('格本身已滿（occupied=capacity）→ 唔係碎片（灰格）', () => {
    const evalr = evaluateDay(day({
      capacity: 3,
      includeFragments: true,
      bookings: Array.from({ length: 6 }, (_, i) => iv(H(10, 30) + (i % 2) * 15, H(10, 45) + (i % 2) * 15)),
    }))
    // 10:30 格 3 人、10:45 格 3 人 → 兩格都滿 → 0 碎片
    assert.equal(evalr.fragments.length, 0)
  })

  it('窗口因 leadTime 唔出 → 唔係碎片（碎片只限容量原因）', () => {
    const evalr = evaluateDay(day({
      capacity: 3,
      includeFragments: true,
      minStartMin: H(10, 30),
      bookings: [
        iv(H(10, 30), H(10, 45)),
        iv(H(10, 30), H(10, 45)),
        iv(H(10, 30), H(10, 45)),
      ],
    }))
    // 10:30 窗 = over_capacity（leadTime 唔阻 10:30 本身）→ 有碎片
    assert.equal(slotAt(evalr, H(10, 30)).status, 'over_capacity')
    assert.equal(evalr.fragments.length, 1)
    // 10:00 窗 = lead_time（容量 0）→ 唔係碎片
    assert.equal(slotAt(evalr, H(10, 0)).status, 'lead_time')
  })

  it('onLeave 日 → 碎片列表空', () => {
    const evalr = evaluateDay(day({ capacity: 3, includeFragments: true, onLeave: true }))
    assert.equal(evalr.fragments.length, 0)
  })

  it('includeFragments 唔傳 → fragments 空（external API 唔出碎片）', () => {
    const evalr = evaluateDay(day({
      capacity: 3,
      bookings: [iv(H(10, 30), H(10, 45)), iv(H(10, 30), H(10, 45)), iv(H(10, 30), H(10, 45))],
    }))
    assert.equal(evalr.fragments.length, 0)
  })
})

// ─── 綜合 ────────────────────────────────────────────────────────────

describe('綜合 case', () => {
  it('全日空 + 全日開診 → 48 窗全出，seatsFree=capacity', () => {
    const evalr = evaluateDay(day({ capacity: 3 }))
    assert.equal(evalr.offerable.length, 48)
    assert.ok(evalr.offerable.every((s) => s.seatsFree === 3))
  })

  it('units 常數：UNIT_MIN=30', () => {
    assert.equal(UNIT_MIN, 30)
  })
})
