import { toHKDateStr, hkDaysInMonth, addDaysStr } from './hk-date'
import { estimateScheduledHours } from './shift-punch-match'

/** 應返 = (曆日 − 當月全部假期日數，按日期去重) × 9；已編班 = 更次跨度（剔走假期日） */
export async function computeRosterHours(
  employeeIds: string[],
  periodMonth: string, // 'YYYY-MM'
  db: any,
  opts?: { shifts?: any[]; lunchMinutes?: Map<string, number> },
): Promise<Map<string, { expectedMinutes: number; rosterMinutes: number; diffMinutes: number; unscheduled: boolean }>> {
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

  const out = new Map<string, { expectedMinutes: number; rosterMinutes: number; diffMinutes: number; unscheduled: boolean }>()
  if (employeeIds.length === 0) return out

  // ★ 在職期間 —— 月中入職／離職唔應該計足一個月
  const emps = await db.employee.findMany({
    where: { id: { in: employeeIds } },
    select: { id: true, joinDate: true, resignedAt: true },
  })
  const empMeta = new Map<string, { joinStr: string; resignStr: string | null }>()
  for (const e of emps) {
    empMeta.set(e.id, {
      joinStr: toHKDateStr(e.joinDate),
      resignStr: e.resignedAt ? toHKDateStr(e.resignedAt) : null,
    })
  }

  // ★ 如果有 opts.shifts 就用，否則自己查
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
    // ★ opts.shifts 優先
    (opts?.shifts ?? db.shift.findMany({
      where: {
        employeeId: { in: employeeIds },
        date: { gte: monthStart, lte: monthEnd },
        status: { not: 'CANCELLED' },
      },
      select: { employeeId: true, date: true, startTime: true, endTime: true, status: true, template: { select: { deductLunch: true } } },
    })),
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
  // ★ 如果有 opts.lunchMinutes 就用，否則自己查
  let lunchMinutesMap: Map<string, number>
  if (opts?.lunchMinutes) {
    lunchMinutesMap = opts.lunchMinutes
  } else {
    lunchMinutesMap = new Map<string, number>()
    for (const r of allPayRules) {
      try {
        const cfg = JSON.parse(r.configJson || '{}')
        lunchMinutesMap.set(r.employeeId, cfg?.modifiers?.lunch_break?.defaultMinutes ?? 60)
      } catch {
        lunchMinutesMap.set(r.employeeId, 60)
      }
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
    const meta = empMeta.get(empId)
    // 在職區間 ∩ 當月
    const effStart = meta && meta.joinStr > monthStartStr ? meta.joinStr : monthStartStr
    const effEnd = meta?.resignStr && meta.resignStr < monthEndStr ? meta.resignStr : monthEndStr

    // 整個月都唔在職 → 全部 0
    if (effStart > effEnd) {
      out.set(empId, { expectedMinutes: 0, rosterMinutes: 0, diffMinutes: 0, unscheduled: false })
      continue
    }

    let inServiceDays = 0
    for (let d = effStart; d <= effEnd; d = addDaysStr(d, 1)) inServiceDays++

    // ★ 假期日亦只計在職區間 —— 兩個數要同一個範圍，否則會互相污染
    const leaveDays = [...(leaveByEmp.get(empId) ?? [])]
      .filter(d => d >= effStart && d <= effEnd).length

    const expectedMinutes = (inServiceDays - leaveDays) * 9 * 60
    const rosterMinutes = rosterMap.get(empId) ?? 0

    // ★ 完全冇排更又冇假 → 「未排更」唔係「欠鐘」
    if (rosterMinutes === 0 && leaveDays === 0) {
      out.set(empId, { expectedMinutes, rosterMinutes: 0, diffMinutes: 0, unscheduled: true })
      continue
    }

    out.set(empId, {
      expectedMinutes, rosterMinutes,
      diffMinutes: rosterMinutes - expectedMinutes,
      unscheduled: false,
    })
  }
  return out
}
