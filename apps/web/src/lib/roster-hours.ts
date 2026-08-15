import { toHKDateStr, hkDaysInMonth, addDaysStr } from './hk-date'
import { rosterSpanHours } from './shift-punch-match'

/** 應返 = (曆日 − 當月全部假期日數，按日期去重) × 9；已編班 = 更次跨度（剔走假期日） */
export async function computeRosterHours(
  employeeIds: string[],
  periodMonth: string, // 'YYYY-MM'
  db: any,
): Promise<Map<string, { expectedMinutes: number; rosterMinutes: number; diffMinutes: number }>> {
  const [py, pmNum] = periodMonth.split('-').map(Number)
  const monthStart = new Date(`${periodMonth}-01T00:00:00+08:00`)
  const nextMonthStart = new Date(
    pmNum === 12
      ? `${py + 1}-01-01T00:00:00+08:00`
      : `${py}-${String(pmNum + 1).padStart(2, '0')}-01T00:00:00+08:00`
  )
  const monthEnd = new Date(nextMonthStart.getTime() - 1)
  const monthStartStr = toHKDateStr(monthStart)
  const monthEndStr = toHKDateStr(monthEnd)
  const daysInMonth = hkDaysInMonth(monthStart)

  const out = new Map<string, { expectedMinutes: number; rosterMinutes: number; diffMinutes: number }>()
  if (employeeIds.length === 0) return out

  const [allLeaves, allShifts] = await Promise.all([
    db.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: 'APPROVED',
        startDate: { lte: nextMonthStart },
        endDate: { gte: monthStart },
      },
      select: { employeeId: true, startDate: true, endDate: true },
    }),
    db.shift.findMany({
      where: {
        employeeId: { in: employeeIds },
        date: { gte: monthStart, lte: monthEnd },
        status: { not: 'CANCELLED' },
      },
      select: { employeeId: true, date: true, startTime: true, endTime: true, status: true },
    }),
  ])

  // 逐個員工砌假期日集合（★按日期去重、只計落喺當月嘅日）
  const leaveByEmp = new Map<string, Set<string>>()
  for (const lr of allLeaves) {
    let s = leaveByEmp.get(lr.employeeId)
    if (!s) { s = new Set(); leaveByEmp.set(lr.employeeId, s) }
    let d = toHKDateStr(lr.startDate)
    const end = toHKDateStr(lr.endDate)
    while (d <= end) {
      if (d >= monthStartStr && d <= monthEndStr) s.add(d)
      d = addDaysStr(d, 1)
    }
  }

  const leaveKeySet = new Set<string>()
  for (const [empId, dates] of leaveByEmp) for (const d of dates) leaveKeySet.add(`${empId}:${d}`)

  const rosterMap = rosterSpanHours(allShifts as any, leaveKeySet)

  for (const empId of employeeIds) {
    const leaveDays = leaveByEmp.get(empId)?.size ?? 0
    const expectedMinutes = (daysInMonth - leaveDays) * 9 * 60
    const rosterMinutes = rosterMap.get(empId) ?? 0
    out.set(empId, { expectedMinutes, rosterMinutes, diffMinutes: rosterMinutes - expectedMinutes })
  }
  return out
}
