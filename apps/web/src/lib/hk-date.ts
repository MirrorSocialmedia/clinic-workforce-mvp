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
