import { hkDateStart, toHKDateStr } from './hk-date'

export const MAX_SHIFT_MINUTES = 16 * 60
export const SHIFT_STATUS_WRITABLE = ['DRAFT', 'CONFIRMED'] as const

/** ★ 2026-09-30 S-06：YYYY-MM-DD 而且係真日期（2026-02-30 唔准靜靜滾去 03-02） */
export function isValidDateStr(d: unknown): d is string {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  try { return toHKDateStr(hkDateStart(d)) === d } catch { return false }
}

/** ★ 2026-09-30 S-06：時長合理性；冇問題回 null */
export function shiftTimesError(t: { startTime: Date; endTime: Date }): string | null {
  const s = t.startTime.getTime()
  const e = t.endTime.getTime()
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '時間格式錯誤（需要 HH:MM）'
  const mins = (e - s) / 60000
  if (mins <= 0) return '收工時間要遲過開工時間'
  if (mins > MAX_SHIFT_MINUTES) return `更次長 ${Math.round(mins / 60)} 小時，超過 16 小時上限（開工同收工係咪打錯？）`
  return null
}

export const hkTimeOf = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)

/** Extract HH:MM from an ISO string using HK timezone */
function parseHHMM(isoStr: string): string {
  return hkTimeOf(new Date(isoStr))
}

/** 由「日期字串 + HK 時分」建一致的三欄。所有 create/update 一律經此。 */
export function buildShiftTimes(dateStr: string, startHHMM: string, endHHMM: string) {
  const startTime = new Date(`${dateStr}T${startHHMM}:00+08:00`)
  const end0 = new Date(`${dateStr}T${endHHMM}:00+08:00`)
  const endTime = end0 <= startTime ? new Date(end0.getTime() + 86400000) : end0
  return { date: hkDateStart(dateStr), startTime, endTime }
}

/** 改期：保留原 HK 時分，換日。 */
export function rebuildShiftDate(existing: { startTime: Date; endTime: Date }, newDateStr: string) {
  return buildShiftTimes(newDateStr, hkTimeOf(existing.startTime), hkTimeOf(existing.endTime))
}

/** 從前端輸入（HH:MM 或 ISO 字串）建一致的三欄 */
export function buildShiftFromInput(dateStr: string, startTimeInput: string, endTimeInput: string) {
  const startHHMM = startTimeInput.includes('T') ? parseHHMM(startTimeInput) : startTimeInput
  const endHHMM = endTimeInput.includes('T') ? parseHHMM(endTimeInput) : endTimeInput
  return buildShiftTimes(dateStr, startHHMM, endHHMM)
}
