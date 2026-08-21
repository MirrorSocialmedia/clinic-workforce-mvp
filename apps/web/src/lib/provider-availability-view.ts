/**
 * ★ cw-pa P4: 醫生時間表（Apricot availability）— page 層純邏輯
 * Spec: docs/specs/PROVIDER_AVAILABILITY_SPEC.md §6（UI）
 *
 * 設計原則：
 * - 呢個檔案係純 function（無 react / 無 fetch / 無 DB），page.tsx 負責渲染。
 *   全部邏輯抽咗出嚟 → node:test 可以斷言（provider-availability-view.test.ts）。
 * - 資料來源只有 GET /api/provider-availability 嘅返回值（flat providers[] +
 *   date-in-entry shape，P3 實裝）。零病人資料、零 DB 直查。
 * - 顏色：Provider.color 優先（#RRGGBB），冇值先 hash 入 fallback palette（§6.2 #5）。
 */

// ─── 類型（mirror GET /api/provider-availability response）───

export interface AvailSlot { date: string; start: string; end: string }
/** ★ 2026-08-21 拍板⑤：逐筆回（唔再合併）；status = Apricot bookingStatus（0=已約/4=已完成） */
export interface BookedSeg { date: string; start: string; end: string; status: number }
export interface ProviderAvail {
  id: string
  name: string
  color: string | null
  openSch: AvailSlot[]
  /** 掃描線合併後 segment；count = 段內總預約筆數（唔係同時人數） */
  booked: BookedSeg[]
  /** ★ 2026-08-21 拍板②：該週（from..to 窗口）預約總筆數 —— 預設只顯示有預約醫生 */
  weekBookings: number
  /** 窗口內有假嘅 HK 日 YYYY-MM-DD（cw-pta spec §4；可能空） */
  leaveDates: string[]
}
export interface AvailabilityResp {
  clinic: { id: string; name: string }
  from: string
  to: string
  sync: { lastSyncAt: string | null; stale: boolean }
  providers: ProviderAvail[]
}

/** 時間軸上的一段（分鐘，00:00 起）；busy 段帶 status（0=已約/4=已完成） */
export interface Range { s: number; e: number; status?: number }

export interface DayProvider {
  providerId: string
  name: string
  color: string | null
  open: Range[]
  /** ★ 2026-08-21 拍板⑤：逐筆（1 busy = 1 預約），重疊由 layoutBookings 分 lane */
  busy: Range[]
  /** 當日該醫生預約總筆數（busy segments 嘅 count 總和）— §6.3 醫生名旁顯示 */
  /** 當日該醫生預約總筆數（= busy 筆數，逐筆回）— §6.3 醫生名旁顯示 */
  total: number
  /** ★ 2026-08-21 拍板②：該週預約總筆數（承傳 ProviderAvail.weekBookings） */
  weekBookings: number
  /** ★ cw-pta spec §4：當日有冇假（ProviderLeave 跨店生效） */
  onLeave: boolean
  /** 拍板①：有假但該日仲有開診/預約 = 矛盾，UI 要標紅 */
  leaveConflict: boolean
}
export interface ScheduleDay { date: string; providers: DayProvider[] }
export interface ClinicOpt { id: string; name: string; connected: boolean }

// ─── 時間解析 ───

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 'HH:mm' → 分鐘數（00:00 起）；格式錯 / 超出 23:59 → null（唔會 throw） */
export function parseHHmm(s: string | null | undefined): number | null {
  if (typeof s !== 'string') return null
  const m = HHMM_RE.exec(s)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 分鐘數（00:00 起）→ 'HH:mm' */
export function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * ISO 8601 → HK 時間 'HH:mm'。
 * 手動 +8h 再用 UTC getter — 唔依賴 Intl/ICU（node 同瀏覽器行為一致）。
 * 無效 ISO → '--:--'
 */
export function formatHKTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '--:--'
  const hk = new Date(d.getTime() + 8 * 3600 * 1000)
  return `${String(hk.getUTCHours()).padStart(2, '0')}:${String(hk.getUTCMinutes()).padStart(2, '0')}`
}

// ─── 顏色 ───

/** spec §6 色板（hash fallback） */
export const FALLBACK_PALETTE = ['#6366f1', '#059669', '#d97706', '#64748b', '#db2777', '#0891b2']

const HEX6_RE = /^#[0-9a-fA-F]{6}$/

export function isValidHexColor(c: unknown): c is string {
  return typeof c === 'string' && HEX6_RE.test(c)
}

/** 醫生色：Provider.color（#RRGGBB）優先；冇值 / 格式錯先 hash 入 palette（§6.2 #5） */
export function providerColor(seed: string, color: string | null | undefined): string {
  if (color != null && isValidHexColor(color)) return color
  let h = 0
  const s = seed ?? ''
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length]
}

/** 同色淺底（band）— 8 位 hex alpha（#6366f1 → #6366f122） */
export function soft(hex: string): string {
  return `${hex}22`
}

// ─── 日期 ───

export const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/** 今日（HK）YYYY-MM-DD */
export function hkTodayStr(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** YYYY-MM-DD 加減日（純 date 運算，UTC 基準，無 timezone 漂移） */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** YYYY-MM-DD → 星期幾（'日'..'六'） */
export function weekdayOf(dateStr: string): string {
  return WEEKDAY[new Date(`${dateStr}T00:00:00Z`).getUTCDay()]
}

// ─── 空閒 gap（§6.1：open − busy，>=30 分鐘先顯示，太碎冇意義）───

export function freeGaps(open: Range[], busy: Range[], minGapMin = 30): Range[] {
  const gaps: Range[] = []
  for (const o of open) {
    let cur = o.s
    for (const b of busy.filter(b => b.s < o.e && b.e > o.s).sort((a, b2) => a.s - b2.s)) {
      if (b.s - cur >= minGapMin) gaps.push({ s: cur, e: b.s })
      cur = Math.max(cur, b.e)
    }
    if (o.e - cur >= minGapMin) gaps.push({ s: cur, e: o.e })
  }
  return gaps
}

// ─── API shape → 渲染 shape（P3 flat providers[] → 7 日 DayProvider[]）───

/**
 * flat providers[]（date-in-entry）→ 7 日 ScheduleDay[]（from..from+6）。
 * - 每日保留「該日有 open / booked / 有假」嘅醫生（純無 data 無假嘅醫生喺該日唔出現，
 *   由 page 層嘅「醫生圖例」統一顯示 + 標「無數據」）。
 * - ★ cw-pta spec §4（★#15）：放假但 Apricot 完全無開診嘅醫生都要出現（onLeave、
 *   open/busy 空）—— 唔好令佢消失。
 * - 'HH:mm' 解析失敗 / end<=start 嘅 entry 直接 drop（唔會 throw）。
 */
export function buildDays(resp: AvailabilityResp): ScheduleDay[] {
  const days: ScheduleDay[] = []
  for (let i = 0; i < 7; i++) {
    const date = addDays(resp.from, i)
    const providers: DayProvider[] = []
    for (const p of resp.providers) {
      const open: Range[] = []
      for (const a of p.openSch) {
        if (a.date !== date) continue
        const s = parseHHmm(a.start)
        const e = parseHHmm(a.end)
        if (s === null || e === null || e <= s) continue
        open.push({ s, e })
      }
      const busy: Range[] = []
      for (const b of p.booked) {
        if (b.date !== date) continue
        const s = parseHHmm(b.start)
        const e = parseHHmm(b.end)
        if (s === null || e === null || e <= s) continue
        busy.push({ s, e, status: b.status })
      }
      const onLeave = (p.leaveDates ?? []).includes(date)
      // ★ 有假嘅日子就算無 open/booked 都保留（§4.2 ★#15）
      if (open.length > 0 || busy.length > 0 || onLeave) {
        providers.push({
          providerId: p.id,
          name: p.name,
          color: p.color,
          open,
          busy,
          total: busy.length, // ★ 逐筆回 → 1 busy = 1 預約
          weekBookings: p.weekBookings,
          onLeave,
          leaveConflict: onLeave && (open.length > 0 || busy.length > 0),
        })
      }
    }
    days.push({ date, providers })
  }
  return days
}

/** 成個 7 日窗口全空（所有醫生都無 openSch、booked 同 leaveDates）→ true */
export function isWeekEmpty(resp: AvailabilityResp): boolean {
  return resp.providers.every(
    p => p.openSch.length === 0 && p.booked.length === 0 && (p.leaveDates?.length ?? 0) === 0,
  )
}

// ─── 時間軸範圍（跟資料 floor/ceil 到整點；fallback 08:00–21:00，§6.2 #9）───

export function computeAxis(days: ScheduleDay[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const d of days)
    for (const p of d.providers)
      for (const r of p.open) {
        lo = Math.min(lo, r.s)
        hi = Math.max(hi, r.e)
      }
  if (!isFinite(lo) || !isFinite(hi)) return [8 * 60, 21 * 60]
  return [Math.floor(lo / 60) * 60, Math.ceil(hi / 60) * 60]
}

// ─── 同步狀態 chip（§7.3 #20 + task brief）───
// API 行為：lastSyncAt=null 時 stale=true。UI 要分三態顯示：
//   lastSyncAt=null → 「未同步過」（唔好寫「同步延遲」，因為根本冇成功過）
//   stale=true      → 「同步延遲（最後成功：HH:mm）」
//   其他            → 「Apricot HH:mm」

export type SyncChipState = 'never' | 'stale' | 'fresh'

export function syncChipState(sync: { lastSyncAt: string | null; stale: boolean }): SyncChipState {
  if (sync.lastSyncAt === null) return 'never'
  return sync.stale ? 'stale' : 'fresh'
}

export interface SyncChip {
  tone: 'gray' | 'warn' | 'ok'
  label: string
}

export function syncChip(sync: { lastSyncAt: string | null; stale: boolean }): SyncChip {
  const st = syncChipState(sync)
  if (st === 'never') return { tone: 'gray', label: '未同步過' }
  const t = formatHKTime(sync.lastSyncAt as string)
  if (st === 'stale') return { tone: 'warn', label: `同步延遲（最後成功：${t}）` }
  return { tone: 'ok', label: `Apricot ${t}` }
}

// ─── 其他小邏輯 ───

/** 診所選擇 default：優先第一間「已接通 Apricot」嘅店；冇接通就第一間；空清單 → '' */
export function defaultClinicId(list: ClinicOpt[]): string {
  return (list.find(c => c.connected) ?? list[0] ?? { id: '' }).id
}

/** 某日無任何醫生有 data 時嘅空狀態文字（§6.1 DayColumn） */
export function dayEmptyText(lastSyncAt: string | null): string {
  return lastSyncAt ? '休診' : '未同步'
}

// ─── 重疊預約橫向分欄（2026-08-21 拍板①⑤；spec MD §3.2）───

/** layoutBookings 輸出：逐筆預約 + lane 位置 */
export interface Positioned { s: number; e: number; status: number
  providerId: string; name: string; color: string
  lane: number; lanes: number; overflow: number }

/**
 * 重疊嘅預約橫向分欄（同 Google Calendar / Apricot 一樣）。
 * ★ 上限 3 lane（拍板①）—— 手機一格得 ~40px，多過 3 條就一個字都放唔落。
 *   第 4 個開始唔畫，計入 cluster 個 overflow，用「+N」窄條顯示。
 *
 * ★★ cluster 掃描用 `sorted[j].s < clusterEnd`（**`<` 唔係 `<=`**）：
 *   19:00–19:30 同 19:30–20:00 係連續唔係重疊，用 `<=` 會夾埋做一個 cluster，
 *   令兩個唔重疊嘅預約無端端各佔半闊（驗收 #14）。
 * ★ lane 重用 `laneEnd.findIndex(end => end <= it.s)` 用 `<=`：
 *   上一個啱啱完，可以重用同一條 lane。
 * ★ `overflow` 係整個 cluster 共用 —— 每個 placed item 都帶住同一個數，
 *   前端只需喺 cluster 第一個塊旁邊畫一次「+N」。
 */
const MAX_LANES = 3

export function layoutBookings(
  items: { s: number; e: number; status: number; providerId: string; name: string; color: string }[],
): Positioned[] {
  const sorted = [...items].sort((a, b) => a.s - b.s || a.e - b.e)
  const out: Positioned[] = []
  let i = 0
  while (i < sorted.length) {
    // ① 掃出一個 cluster（連續重疊）
    const cluster = [sorted[i]]
    let clusterEnd = sorted[i].e
    let j = i + 1
    while (j < sorted.length && sorted[j].s < clusterEnd) {
      cluster.push(sorted[j])
      clusterEnd = Math.max(clusterEnd, sorted[j].e)
      j++
    }
    // ② cluster 內分 lane
    const laneEnd: number[] = []
    const placed: { item: typeof cluster[0]; lane: number }[] = []
    let overflow = 0
    for (const it of cluster) {
      let lane = laneEnd.findIndex(end => end <= it.s)
      if (lane === -1) {
        if (laneEnd.length >= MAX_LANES) { overflow++; continue }   // ★ 上限
        lane = laneEnd.length
      }
      laneEnd[lane] = it.e
      placed.push({ item: it, lane })
    }
    const lanes = Math.max(1, laneEnd.length)
    for (const { item, lane } of placed) {
      out.push({ ...item, lane, lanes, overflow })
    }
    i = j
  }
  return out
}
