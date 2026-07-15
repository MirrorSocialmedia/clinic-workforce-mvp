import { hkDateStart } from './hk-date'

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
