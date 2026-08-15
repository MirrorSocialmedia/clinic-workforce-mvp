import { toHKDateStr, hkDaysInMonth, addDaysStr } from './hk-date'
import { estimateScheduledHours } from './shift-punch-match'

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

  const [allLeaves, allShifts, allPayRules] = await Promise.all([
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
      select: { employeeId: true, date: true, startTime: true, endTime: true, status: true, template: { select: { deductLunch: true } } },
    }),
    db.payRule.findMany({
      where: { employeeId: { in: employeeIds }, isActive: true },
      select: { employeeId: true, configJson: true },
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

  // ★ 2026-08-15：合約 9 小時係【淨工時】唔係跨度 —— 一定要扣午飯，
  // 否則每個工作日多算一個飯鐘（每人每月約 +21h 假 OT）。
  const lunchMinutesMap = new Map<string, number>()
  for (const r of allPayRules) {
    try {
      const cfg = JSON.parse(r.configJson || '{}')
      lunchMinutesMap.set(r.employeeId, cfg?.modifiers?.lunch_break?.defaultMinutes ?? 60)
    } catch {
      lunchMinutesMap.set(r.employeeId, 60)
    }
  }

  const perDay = estimateScheduledHours(allShifts as any, id => lunchMinutesMap.get(id) ?? 60)
  const rosterMap = new Map<string, number>()
  for (const [empId, days] of perDay) {
    let mins = 0
    for (const d of days) {
      if (leaveKeySet.has(`${empId}:${d.date}`)) continue // ★ 假期日唔計
      mins += d.hours * 60
    }
    rosterMap.set(empId, Math.round(mins))
  }

  for (const empId of employeeIds) {
    const leaveDays = leaveByEmp.get(empId)?.size ?? 0
    const expectedMinutes = (daysInMonth - leaveDays) * 9 * 60
    const rosterMinutes = rosterMap.get(empId) ?? 0
    out.set(empId, { expectedMinutes, rosterMinutes, diffMinutes: rosterMinutes - expectedMinutes })
  }
  return out
}
