import { prisma } from './prisma'
import { getEffectivePunches } from './punch-query'
import { matchPunchesToShifts, type MatchedDay } from './shift-punch-match'
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
  // ★ cwm-attfix-20260927 B：調鋪 —— 一張更有 clinicId（上午店）同 secondaryClinicId（下午店），落班卡通常喺下午店打。
  //   打卡要攞埋 secondaryClinicId 嗰間店，否則調鋪員工過咗收工就會誤報「漏落班卡」。
  //   matchPunchesToShifts 會按每張更自己嘅 clinicId／secondaryClinicId 再過濾（shift-punch-match.ts），
  //   所以唔會誤用同一員工喺第三間店嘅卡。
  const punchClinicIds = [...new Set([
    clinicId,
    ...shifts.map(s => s.secondaryClinicId).filter((v): v is string => !!v),
  ])]
  const punches = empIds.length
    ? await getEffectivePunches(todayStart, new Date(todayEnd.getTime() - 1), { employeeIds: empIds, clinicIds: punchClinicIds })
    : []
  // ★ cwm-attfix-20260927 B：按員工一次過 match 佢今日喺呢間店嘅所有更 —— 同店分更先會用時間窗切開
  //   （shift-punch-match.ts 分更邏輯）。舊寫法逐張更單獨 match，第二更會攞到第一更嘅上班卡。
  const matchByShift = new Map<string, MatchedDay>()
  for (const empId of empIds) {
    const empShifts = shifts.filter(s => s.employeeId === empId)
    const mine = punches
      .filter(p => p.raw?.employeeId === empId)
      .map(p => ({ effectiveTime: p.effectiveTime, punchType: p.punchType, clinicId: p.clinicId }))
    for (const md of matchPunchesToShifts(empShifts, mine)) matchByShift.set(md.shiftId, md)
  }
  const people: TodayPerson[] = []
  for (const s of shifts) {
    const m = matchByShift.get(s.id)
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
