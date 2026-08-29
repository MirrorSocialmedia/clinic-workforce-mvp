// ============================================================
// 可約時段核心純邏輯 — providerslot-20260830 T1
//
// MD: whatsapp-flow-booking.md §一「核心規則：15 分鐘數據，30 分鐘出位」
//
// 設計原則（照 provider-pattern.ts / provider-availability-view.ts）：
// - 全部純 function（無 DB / 無 fetch / 無 clock）→ node:test 直接斷言。
// - 15 分鐘格 concurrency 時間線（MD 明示：粒度 15 分鐘，booking 開頭會落
//   :15/:45）→ 窗口 [t, t+30) 內 max(concurrency) 檢查。
// - ★ MD 10:30 反例鐵律：「同時 ≤ capacity−1」≠「有一條 lane 全空」。
//   容量 3 只係「任何一刻不超過 3 人」，不是三張具名椅。唔准做 lane
//   分配檢查（會錯殺可約時段）。
//
// offerable 五條件（MD §一）：
//   ① W 完全落 openSch（扣午休 — 傳入嘅 openSch 已係扣咗午休嘅 interval 集）
//   ② W 內每一刻同時預約數 ≤ capacity−1（bookings-only 時間線 max）
//   ③ 該日無 ProviderLeave（route 層用 roster 三層疊過濾，呢度 onLeave flag）
//   ④ t ≥ now + leadTimeMin（minStartMin 參數；null = 非今日，無約束）
//   ⑤ 無 ProviderHold 覆蓋 W（30m 對齊下 overlap ⟺ 同一個 30m 位）
//
// 另出：seatsFree = capacity − max(occupied)（occupied = bookings + holds）
//       fragment = 15m 子窗口 occupied < capacity 但所屬 30m 窗口因
//       over_capacity 唔可出 — **只係 UI 內部用，external API 唔出**（MD §一）。
// ============================================================

/** 線上出位單位（分鐘）— 一律 30，對齊 :00/:30 */
export const UNIT_MIN = 30
/** concurrency 時間線格粒度（分鐘）— MD：15 分鐘一格就夠 */
export const CELL_MIN = 15
export const CELLS_PER_DAY = 1440 / CELL_MIN
export const WINDOWS_PER_DAY = 1440 / UNIT_MIN

export interface Interval {
  startMin: number
  endMin: number
}

/** 槽位狀態（reason 優先序 = evaluateDay 判斷序 — 第一個命中先出） */
export type SlotStatus =
  | 'offerable'
  | 'on_leave'
  | 'outside_open'
  | 'lead_time'
  | 'over_capacity'
  | 'held_overlap'

export interface SlotEval {
  startMin: number
  endMin: number
  status: SlotStatus
  /** W 內 max 同時數（bookings only）— 條件 ② */
  maxBookings: number
  /** W 內 max 同時數（bookings + holds）— seatsFree 用 */
  maxOccupancy: number
  /** offerable 先 = capacity − maxOccupancy（≥1）；其他 = 0 */
  seatsFree: number
}

/** 15 分鐘碎片（UI 內部 — 「只人手可插」；external API 唔出） */
export interface FragmentCell {
  startMin: number
  endMin: number
  /** capacity − occupied(cell)（≥1） */
  seatsFree: number
}

export interface DayEvalInput {
  /** 按醫生同時上限（≥1；MD 預設 3） */
  capacity: number
  /** 條件 ③ — 該日該醫生有 ProviderLeave */
  onLeave: boolean
  /** 條件 ④ — 當日最早可約 start（分鐘）；null = 非今日（無約束） */
  minStartMin: number | null
  /** 條件 ① 數據 — 該日開診時段（已扣午休），分鐘 */
  openSch: Interval[]
  /** 該日 active 預約（15 分鐘粒度 raw，已剔取消/完成） */
  bookings: Interval[]
  /** 該日 active hold（HELD | IN_APRICOT） */
  holds: Interval[]
  /** 算碎片（UI 內部用；external API 唔使） */
  includeFragments?: boolean
}

export interface DayEval {
  /** 全日 48 個 :00/:30 窗口（含不可出 — 俾 UI 畫四態格） */
  slots: SlotEval[]
  /** offerable 子集 */
  offerable: SlotEval[]
  /** 15 分鐘碎片（includeFragments=true 先非空） */
  fragments: FragmentCell[]
}

// ─── 時間工具 ──────────────────────────────────────────────────────────

export function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

export function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/** 'HH:mm' 格式檢查（route 層 query 驗證用） */
export function isHHmm(s: string): boolean {
  return /^\d{2}:\d{2}$/.test(s) && Number(s.slice(3)) <= 59 && Number(s.slice(0, 2)) <= 23
}

// ─── 核心 ──────────────────────────────────────────────────────────────

/**
 * 15 分鐘格 concurrency 時間線（MD §一實作指定）：
 * 把當日 booking/hold 攤成 96 格（每格 [15i, 15(i+1))），逐格計重疊數。
 * 窗口檢查只係取格內 max — O(格數)，唔逐 booking 逐窗口掃（3s SLA 意識）。
 */
export function buildTimeline(
  intervals: Interval[],
  cells: number = CELLS_PER_DAY,
  cellMin: number = CELL_MIN,
): number[] {
  const t = new Array<number>(cells).fill(0)
  for (const iv of intervals) {
    if (!iv || !Number.isFinite(iv.startMin) || !Number.isFinite(iv.endMin)) continue
    if (iv.endMin <= iv.startMin) continue // 壞數據跳過（sync 已 filter，多一層防御）
    const first = Math.max(0, Math.floor(iv.startMin / cellMin))
    const last = Math.min(cells - 1, Math.ceil(iv.endMin / cellMin) - 1)
    for (let i = first; i <= last; i++) t[i]++
  }
  return t
}

/** iv 完全落在 cover 集（任一 interval 包晒 iv）— 條件 ① */
export function intervalCovered(cover: Interval[], iv: Interval): boolean {
  for (const c of cover) {
    if (c.startMin <= iv.startMin && iv.endMin <= c.endMin) return true
  }
  return false
}

/** 任一行與窗口 w 有重疊 — 條件 ⑤ */
export function anyOverlap(intervals: Interval[], w: Interval): boolean {
  for (const iv of intervals) {
    if (iv.startMin < w.endMin && iv.endMin > w.startMin) return true
  }
  return false
}

/** 15 分鐘格子 (startMin) 所屬嘅 30 分鐘窗口（:00 格 → 上窗口起點；:30 格 → −15） */
export function windowOfCell(cellStartMin: number): Interval {
  return cellStartMin % UNIT_MIN === 0
    ? { startMin: cellStartMin, endMin: cellStartMin + UNIT_MIN }
    : { startMin: cellStartMin - CELL_MIN, endMin: cellStartMin + CELL_MIN }
}

/**
 * 逐日逐醫生評估（純函數 — MD §一五條件）。
 *
 * @throws RangeError — capacity 唔係 ≥1 整數（defense in depth；route 已驗證）
 */
export function evaluateDay(input: DayEvalInput): DayEval {
  const { capacity, onLeave, minStartMin, openSch, bookings, holds, includeFragments } = input
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`evaluateDay: capacity 必須係 ≥1 整數（收到 ${capacity}）`)
  }

  const bookT = buildTimeline(bookings)
  const holdT = buildTimeline(holds)
  // occupied = bookings + holds（hold 已佔住位 — seatsFree 要扣）
  const occT = bookT.map((v, i) => v + holdT[i])

  const slots: SlotEval[] = []
  for (let s = 0; s < 1440; s += UNIT_MIN) {
    const w: Interval = { startMin: s, endMin: s + UNIT_MIN }
    const c0 = s / CELL_MIN
    const c1 = c0 + UNIT_MIN / CELL_MIN - 1 // 窗口覆蓋 2 格
    const maxBookings = Math.max(bookT[c0], bookT[c1])
    const maxOccupancy = Math.max(occT[c0], occT[c1])

    // 五條件（reason 優先序：leave > openSch > leadTime > capacity > hold）
    let status: SlotStatus
    if (onLeave) status = 'on_leave'
    else if (!intervalCovered(openSch, w)) status = 'outside_open'
    else if (minStartMin !== null && s < minStartMin) status = 'lead_time'
    else if (maxBookings > capacity - 1) status = 'over_capacity'
    else if (anyOverlap(holds, w)) status = 'held_overlap'
    else status = 'offerable'

    slots.push({
      startMin: s,
      endMin: s + UNIT_MIN,
      status,
      maxBookings,
      maxOccupancy,
      seatsFree: status === 'offerable' ? capacity - maxOccupancy : 0,
    })
  }

  // 碎片（MD §一）：15m 子窗口 occupied < capacity 但所屬 30m 窗口
  // **因容量**（over_capacity）唔可出 — 其他原因（leadTime/leave/openSch）
  // 唔算碎片（前台人手插唔到未開診/已放假日/leadTime 前嘅位）。
  const fragments: FragmentCell[] = []
  if (includeFragments) {
    for (let i = 0; i < CELLS_PER_DAY; i++) {
      const cellStart = i * CELL_MIN
      if (occT[i] >= capacity) continue // 格本身已滿 → 灰格唔係碎片
      const w = windowOfCell(cellStart)
      const wEval = slots[w.startMin / UNIT_MIN]
      if (wEval && wEval.status === 'over_capacity') {
        fragments.push({ startMin: cellStart, endMin: cellStart + CELL_MIN, seatsFree: capacity - occT[i] })
      }
    }
  }

  return {
    slots,
    offerable: slots.filter((s) => s.status === 'offerable'),
    fragments,
  }
}
