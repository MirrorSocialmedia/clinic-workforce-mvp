import { toHKDateStr } from './hk-date'

const fmtHM = (d: Date) => {
  const s = new Date(d.getTime() + 8 * 3600 * 1000)
  return `${String(s.getUTCHours()).padStart(2, '0')}:${String(s.getUTCMinutes()).padStart(2, '0')}`
}
const md = (d: Date) => toHKDateStr(d).slice(5).replace('-', '月') + '日'

export function describeShiftChange(before: any, after: any, clinicName: (id: string) => string): string {
  const parts: string[] = []
  const bStart = fmtHM(before.startTime), aStart = fmtHM(after.startTime)
  const bEnd = fmtHM(before.endTime), aEnd = fmtHM(after.endTime)
  if (bStart !== aStart || bEnd !== aEnd) {
    parts.push(`時間由 ${bStart}-${bEnd} 改為 ${aStart}-${aEnd}`)
  }
  if (before.clinicId !== after.clinicId) {
    parts.push(`地點由 ${clinicName(before.clinicId)} 改為 ${clinicName(after.clinicId)}`)
  }
  if ((before.secondaryClinicId ?? null) !== (after.secondaryClinicId ?? null)) {
    parts.push(after.secondaryClinicId
      ? `改為調鋪（下午去 ${clinicName(after.secondaryClinicId)}）`
      : `取消調鋪`)
  }
  if (toHKDateStr(before.date) !== toHKDateStr(after.date)) {
    parts.push(`日期由 ${md(before.date)} 改為 ${md(after.date)}`)
  }
  return parts.length ? `${md(after.date)} ${parts.join('、')}` : `${md(after.date)} 更次已更新`
}

export const shiftDeletedMsg = (s: any, clinicName: (id: string) => string) =>
  `${md(s.date)} ${clinicName(s.clinicId)} ${fmtHM(s.startTime)}-${fmtHM(s.endTime)} 更次已被取消`

export const shiftReplacedMsg = (s: any, clinicName: (id: string) => string) =>
  `${md(s.date)} ${clinicName(s.clinicId)} ${fmtHM(s.startTime)}-${fmtHM(s.endTime)} 更次已被新更次取代`

// ★ 合併通知 builder
export function buildNotification(empId: string, items: string[], relatedId?: string) {
  return {
    employeeId: empId,
    type: 'SHIFT_CHANGED',
    content: items.length === 1 ? items[0] : `你的排班有 ${items.length} 項更新`,
    relatedEntity: 'Shift',
    relatedId: relatedId ?? null,
    details: items.length > 1 ? JSON.stringify(items) : null,
  }
}
