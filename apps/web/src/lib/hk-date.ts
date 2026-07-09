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

/** 格式化時間顯示 HH:MM，失敗返回 '--:--' */
export function fmtTime(dt: string | Date | undefined | null): string {
  if (!dt) return '--:--'
  const d = new Date(dt)
  if (isNaN(d.getTime())) return '--:--'
  return d.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false })
}
