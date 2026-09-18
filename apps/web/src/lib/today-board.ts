import { prisma } from './prisma'
import { getEffectivePunches } from './punch-query'
import { matchPunchesToShifts } from './shift-punch-match'
import { toHKDateStr, leaveCoversDate } from './hk-date'

export type TodayPerson = {
  employeeId: string; name: string
  status: 'ARRIVED' | 'LATE' | 'NOT_ARRIVED' | 'NOT_STARTED' | 'LEFT' | 'MISSING_OUT'
  shiftStart: string; shiftEnd: string
  minutes?: number
}
const NOT_ARRIVED_GRACE_MIN = 5   // 純顯示用，唔影響計糧
const MISSING_OUT_GRACE_MIN = 30

/** ★ cwm-ownerdash-20260917：單一診所今日出勤看板 */
export async function buildTodayBoard(clinicId: string, todayStart: Date, todayEnd: Date, now = new Date()) {
  const shifts = await prisma.shift.findMany({
    where: { clinicId, date: { gte: todayStart, lt: todayEnd }, status: { notIn: ['CANCELLED', 'DRAFT'] } },
    select: { id: true, employeeId: true, startTime: true, endTime: true, clinicId: true, secondaryClinicId: true, date: true, status: true,
      employee: { select: { user: { select: { name: true } } } } },
    orderBy: { startTime: 'asc' },
  })
  const empIds = [...new Set(shifts.map(s => s.employeeId))]
  const punches = empIds.length
    ? await getEffectivePunches(todayStart, new Date(todayEnd.getTime() - 1), { employeeIds: empIds, clinicId })
    : []
  const people: TodayPerson[] = []
  for (const s of shifts) {
    const mine = punches.filter(p => p.raw?.employeeId === s.employeeId)
    const [m] = matchPunchesToShifts([s], mine.map(p => ({ effectiveTime: p.effectiveTime, punchType: p.punchType, clinicId: p.clinicId })))
    const start = new Date(s.startTime), end = new Date(s.endTime)
    const sinceStart = Math.floor((now.getTime() - start.getTime()) / 60000)
    const sinceEnd = Math.floor((now.getTime() - end.getTime()) / 60000)
    let status: TodayPerson['status']
    let minutes: number | undefined
    if (m?.hasClockIn && m.hasClockOut) status = 'LEFT'
    else if (m?.hasClockIn && sinceEnd >= MISSING_OUT_GRACE_MIN) status = 'MISSING_OUT'
    else if (m?.hasClockIn && m.lateMinutes > 0) { status = 'LATE'; minutes = m.lateMinutes }
    else if (m?.hasClockIn) status = 'ARRIVED'
    else if (sinceStart >= NOT_ARRIVED_GRACE_MIN) { status = 'NOT_ARRIVED'; minutes = sinceStart }
    else status = 'NOT_STARTED'
    people.push({ employeeId: s.employeeId, name: s.employee?.user?.name ?? '', status, shiftStart: start.toISOString(), shiftEnd: end.toISOString(), minutes })
  }

  // 請假：按主屬店（假期冇 clinicId —— 同排班頁 :4739 口徑一致）
  const todayStr = toHKDateStr(todayStart)
  const leaves = await prisma.leaveRequest.findMany({
    where: {
      status: 'APPROVED',
      startDate: { lte: todayEnd }, endDate: { gte: new Date(todayStart.getTime() - 86400000) },
      employee: { homeClinicId: clinicId },
    },
    select: { startDate: true, endDate: true, employee: { select: { id: true, user: { select: { name: true } } } }, leaveType: { select: { name: true } } },
  })
  const onLeaveRaw = leaves.filter(l => leaveCoversDate(l, todayStr))
    .map(l => ({ employeeId: l.employee.id, name: l.employee.user.name, leaveType: l.leaveType?.name ?? '假期' }))
  // ⚠️ 同一人兩張假單 → 去重
  const onLeave = [...new Map(onLeaveRaw.map(x => [x.employeeId, x])).values()]

  const count = (st: TodayPerson['status']) => people.filter(p => p.status === st).length
  const started = people.filter(p => p.status !== 'NOT_STARTED')
  return {
    scheduled: new Set(people.map(p => p.employeeId)).size,
    expected: new Set(started.map(p => p.employeeId)).size,
    clockedIn: new Set(people.filter(p => ['ARRIVED', 'LATE', 'LEFT', 'MISSING_OUT'].includes(p.status)).map(p => p.employeeId)).size,
    late: count('LATE'),
    notArrived: count('NOT_ARRIVED'),
    notStarted: count('NOT_STARTED'),
    missingOut: count('MISSING_OUT'),
    onLeaveCount: onLeave.length,
    people, onLeave,
  }
}
