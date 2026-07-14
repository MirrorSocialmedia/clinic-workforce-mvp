/** 將 Date 轉為香港時區的 YYYY-MM-DD */
export function toHKDateStr(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt)
}

/** 今日香港日期 YYYY-MM-DD */
export function todayHK(): string {
  return toHKDateStr(new Date())
}

/** YYYY-MM-DD → midnight HK (e.g. "2026-07-06" → new Date("2026-07-06T00:00:00+08:00")) */
export function hkDateStart(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+08:00`)
}

/** YYYY-MM-DD → end of day HK (e.g. "2026-07-06" → new Date("2026-07-06T23:59:59.999+08:00")) */
export function hkDateEnd(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999+08:00`)
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

/** 假期是否涵蓋某天（HK日期 YYYY-MM-DD） */
export function leaveCoversDate(lr: { startDate: string; endDate?: string | null }, dateStr: string): boolean {
  const s = toHKDateStr(new Date(lr.startDate))
  const e = toHKDateStr(new Date(lr.endDate || lr.startDate))
  return dateStr >= s && dateStr <= e
}

/** Get month range [first day 00:00 HK, last day 23:59:59.999 HK] — timezone-safe via +08:00 string */
export function getMonthRange(date: Date) {
  const y = date.getFullYear()
  const m = date.getMonth()
  const ym = `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}`
  const start = new Date(`${ym}-01T00:00:00+08:00`)
  // End of month = 1ms before 1st of next month (HK)
  const nextMonth = m + 1 >= 12
    ? `${String(y + 1).padStart(4, '0')}-01`
    : `${String(y).padStart(4, '0')}-${String(m + 2).padStart(2, '0')}`
  const end = new Date(Date.parse(`${nextMonth}-01T00:00:00+08:00`) - 1)
  return { start, end }
}
