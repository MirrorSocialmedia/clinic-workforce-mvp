// ★ formatter 只建立一次 —— new Intl.DateTimeFormat 是熱路徑最貴的一步
const HK_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Hong_Kong',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** 將 Date 轉為香港時區的 YYYY-MM-DD */
export function toHKDateStr(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  return HK_DATE_FMT.format(dt)
}

/** 今日香港日期 YYYY-MM-DD */
export function todayHK(): string {
  return toHKDateStr(new Date())
}

/** 今日香港日期 YYYY-MM-DD —— todayHK() 別名（2026-09-04 [cwm-resigpay-20260904] 命名對齊） */
export function hkTodayStr(): string {
  return todayHK()
}

/** YYYY-MM-DD → midnight HK (e.g. "2026-07-06" → new Date("2026-07-06T00:00:00+08:00")) */
export function hkDateStart(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00+08:00`)
  // ★ 傳錯格式（例如 ISO 全格式）會拼出 Invalid Date，
  //   而 Invalid Date 傳落 Prisma 只會出一個好難查嘅 validation error。
  //   喺呢度即刻報，訊息清楚好多。
  if (isNaN(d.getTime())) {
    throw new Error(`hkDateStart: 無效日期字串「${dateStr}」（需要 YYYY-MM-DD）`)
  }
  return d
}

/** 'YYYY-MM-DD' → HK 午夜 Date。用於 joinDate / leaveDate 等純日期欄位。 */
export const hkDateOnly = (s: string): Date => new Date(`${s}T00:00:00+08:00`)

/** YYYY-MM-DD → end of day HK (e.g. "2026-07-06" → new Date("2026-07-06T23:59:59.999+08:00")) */
export function hkDateEnd(dateStr: string): Date {
  const d = new Date(`${dateStr}T23:59:59.999+08:00`)
  if (isNaN(d.getTime())) {
    throw new Error(`hkDateEnd: 無效日期字串「${dateStr}」（需要 YYYY-MM-DD）`)
  }
  return d
}

const HK = { timeZone: 'Asia/Hong_Kong' } as const

/** 格式化時間顯示 HH:MM，失敗返回 '--:--' */
export function fmtTime(dt: string | Date | undefined | null): string {
  if (!dt) return '--:--'
  const d = new Date(dt)
  if (isNaN(d.getTime())) return '--:--'
  return d.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false, ...HK })
}

/** 格式化日期顯示，失敗返回 '--' */
export function fmtDate(dt: string | Date | undefined | null): string {
  if (!dt) return '--'
  const d = new Date(dt)
  if (isNaN(d.getTime())) return '--'
  return d.toLocaleDateString('zh-HK', { ...HK })
}

/** 格式化日期+時間顯示，失敗返回 '--' */
export function fmtDateTime(dt: string | Date | undefined | null): string {
  if (!dt) return '--'
  const d = new Date(dt)
  if (isNaN(d.getTime())) return '--'
  return d.toLocaleString('zh-HK', { ...HK, hour12: false })
}

/** 格式化 D/M/YYYY（例如 31/7/2026，月/日無前導零）—— HK 時區；空值返回 '—'（薪俸結算書用） */
export function fmtDMY(dt: string | Date | null | undefined): string {
  if (!dt) return '—'
  const d = new Date(dt)
  if (isNaN(d.getTime())) return '—'
  const [y, m, day] = toHKDateStr(d).split('-').map(Number)
  return `${day}/${m}/${y}`
}

/** 假期是否涵蓋某天（HK日期 YYYY-MM-DD） */
export function leaveCoversDate(lr: { startDate: string | Date; endDate?: string | Date | null }, dateStr: string): boolean {
  const s = toHKDateStr(new Date(lr.startDate))
  const e = toHKDateStr(new Date(lr.endDate || lr.startDate))
  return dateStr >= s && dateStr <= e
}

/** Get month range [1日 00:00 HK, 月末 23:59:59.999 HK] — 年月取自 HK 視角（Intl），全程無本機時區 */
export function getMonthRange(date: Date) {
  const ym = toHKDateStr(date).slice(0, 7) // ★ HK 視角的年月（Intl 保證）
  const [y, m] = ym.split('-').map(Number)
  const start = new Date(`${ym}-01T00:00:00+08:00`)
  const nextYm = m >= 12
    ? `${y + 1}-01`
    : `${y}-${String(m + 1).padStart(2, '0')}`
  const end = new Date(Date.parse(`${nextYm}-01T00:00:00+08:00`) - 1)
  return { start, end }
}

/** 取 HK 年/月/日（m 為 0-based） */
export function hkParts(d: Date): { y: number; m: number; day: number } {
  const [y, m, day] = toHKDateStr(d).split('-').map(Number)
  return { y, m: m - 1, day }
}

/** HK 視角的當月天數 */
export function hkDaysInMonth(d: Date): number {
  const { y, m } = hkParts(d)
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
}

/**
 * 日期範圍 [from, to] 嘅曆日數（含頭含尾，HK 日）。
 * ★ 2026-09-06 [cwm-caldayratio]：離職當月曆日比例 ＋ MPF 不完整糧期下限 pro-rate
 *   嘅【唯一】計日口徑 — engine（resolveEmployedRatio）同 mpf-exemption
 *   （employedDaysInMpfPeriod / adjustMpfMinForPeriod / 結算卡顯示）全部共用。
 *   ⚠️ 一定要 +1（含頭含尾）：9/1→9/10 = 10 日，漏咗 = Selina 少 $583。
 *   ⚠️ HK 日界（toHKDateStr + hkDateStart）相減 — UTC 算會差一日。
 *   ⚠️ from > to（範圍空）→ ≤ 0 — caller 自己 guard（ratio 返 0 / MPF 唔調整）。
 */
export function countHKDaysInclusive(from: Date, to: Date): number {
  const a = hkDateStart(toHKDateStr(from)).getTime()
  const b = hkDateStart(toHKDateStr(to)).getTime()
  return Math.floor((b - a) / 86400000) + 1
}

/** HK 視角某天是星期幾（0=日）。收 'YYYY-MM-DD' 或 Date */
export function hkDayOfWeek(input: string | Date): number {
  const s = typeof input === 'string' ? input : toHKDateStr(input)
  const [y, m, day] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day)).getUTCDay()
}

/** 對 'YYYY-MM-DD' 做 ±n 天，回 'YYYY-MM-DD' */
export function addDays(dateStr: string, n: number): string {
  const [y, m, day] = dateStr.split('-').map(Number)
  const utc = new Date(Date.UTC(y, m - 1, day + n))
  return toHKDateStr(utc)
}

/** 日期字串加 N 日（YYYY-MM-DD）—— 唔經 Intl 格式化，避免時區同效能問題 */
export function addDaysStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/**
 * ★ 2026-09-05 [cwm-resignroster]：HK 日期字串列（含頭含尾），同 toHKDateStr 口徑。
 * 收 'YYYY-MM-DD' 或 Date；from > to → 空陣列。
 * HK 無夏令時 → +86400000ms 迭代安全（同 engine 產／侍產假迴圈同一做法）。
 */
export function hkDaysBetween(from: Date | string, to: Date | string): string[] {
  let cur = toHKDateStr(from)
  const last = toHKDateStr(to)
  if (cur > last) return []
  const out: string[] = []
  while (cur <= last) {
    out.push(cur)
    cur = addDays(cur, 1)
  }
  return out
}

/** PayrollRun.periodMonth (DateTime, HK 月初午夜) → "YYYY-MM"
 *  — Date → toHKDateStr().slice(0,7)
 *  — plain "YYYY-MM" string → passthrough
 *  — ISO "YYYY-MM-DDT..." string → toHKDateStr().slice(0,7) (UTC→HK safe)
 */
export function periodMonthKey(pm: Date | string): string {
  if (typeof pm === 'string') {
    // Plain "YYYY-MM" — return as-is
    if (/^\d{4}-\d{2}$/.test(pm)) return pm
    // ISO timestamp — convert via HK
    return toHKDateStr(pm).slice(0, 7)
  }
  return toHKDateStr(pm).slice(0, 7)
}
