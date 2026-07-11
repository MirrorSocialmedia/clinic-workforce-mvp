/** 將 Date 轉為香港時區的 YYYY-MM-DD */
export function toHKDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
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

/** 格式化時間顯示 HH:MM，失敗返回 '--:--' */
export function fmtTime(dt: string | Date | undefined | null): string {
  if (!dt) return '--:--'
  const d = new Date(dt)
  if (isNaN(d.getTime())) return '--:--'
  return d.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false })
}
