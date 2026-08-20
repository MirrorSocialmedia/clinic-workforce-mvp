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
export interface BookedSeg { date: string; start: string; end: string; count: number }
export interface ProviderAvail {
  id: string
  name: string
  color: string | null
  openSch: AvailSlot[]
  /** 掃描線合併後 segment；count = 段內總預約筆數（唔係同時人數） */
  booked: BookedSeg[]
}
export interface AvailabilityResp {
  clinic: { id: string; name: string }
  from: string
  to: string
  sync: { lastSyncAt: string | null; stale: boolean }
  providers: ProviderAvail[]
}

/** 時間軸上的一段（分鐘，00:00 起） */
export interface Range { s: number; e: number; count?: number }

export interface DayProvider {
  providerId: string
  name: string
  color: string | null
  open: Range[]
  busy: Range[]
  /** 當日該醫生預約總筆數（busy segments 嘅 count 總和）— §6.3 醫生名旁顯示 */
  total: number
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
 * - 每日只保留「該日有 open 或 booked」嘅醫生（無 data 醫生喺該日唔出現，
 *   由 page 層嘅「醫生圖例」統一顯示 + 標「無數據」）。
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
        busy.push({ s, e, count: b.count })
      }
      if (open.length > 0 || busy.length > 0) {
        providers.push({
          providerId: p.id,
          name: p.name,
          color: p.color,
          open,
          busy,
          total: busy.reduce((t, b) => t + (b.count ?? 0), 0),
        })
      }
    }
    days.push({ date, providers })
  }
  return days
}

/** 成個 7 日窗口全空（所有醫生都無 openSch 同 booked）→ true */
export function isWeekEmpty(resp: AvailabilityResp): boolean {
  return resp.providers.every(p => p.openSch.length === 0 && p.booked.length === 0)
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
