import { toHKDateStr, addDaysStr } from './hk-date'
import { estimateScheduledHours } from './shift-punch-match'

/** 編更差額 note 字串 + Prisma 過濾器 */
export const rosterDiffNote = (month: string) => `編更差額 ${month}`
export const rosterDiffNoteFilter = (month: string) => ({ contains: rosterDiffNote(month) })

/**
 * ★ 2026-09-30 [cwm-rosterjoin]：單一員工編更差額（純函數 — 所有顯示／入帳 call site 同一條式）
 * 應返 = (在職曆日 − 在職期內假期日數) × 9h；在職 = 入職日 ~ 最後工作日（∩ 當月）
 * ⚠️ resignedAt 存嘅係「最後工作日**翌日** HK 午夜」（resign-cutoff.ts）→ 在職尾 = resignedAt − 1 日
 *    （同 payroll-engine employedPeriod 同口徑；舊版直接用 resignedAt 會多計一日應返 = 無端 −9h）
 */
export function computeRosterDiff(a: {
  joinStr: string | null        // 入職日 'YYYY-MM-DD'（null = 當月初）
  lastWorkDayStr: string | null // 最後工作日 'YYYY-MM-DD'（null = 在職）
  monthStartStr: string
  monthEndStr: string
  leaveDates: Iterable<string>  // 已批假期日（已去重；範圍外會自動剔走）
  rosterMinutes: number         // 已編班淨工時（已剔走假期日）
}): { expectedMinutes: number; rosterMinutes: number; diffMinutes: number; unscheduled: boolean } {
  const effStart = a.joinStr && a.joinStr > a.monthStartStr ? a.joinStr : a.monthStartStr
  const effEnd = a.lastWorkDayStr && a.lastWorkDayStr < a.monthEndStr ? a.lastWorkDayStr : a.monthEndStr
  // 整個月都唔在職 → 全部 0
  if (effStart > effEnd) return { expectedMinutes: 0, rosterMinutes: 0, diffMinutes: 0, unscheduled: false }

  let inServiceDays = 0
  for (let d = effStart; d <= effEnd; d = addDaysStr(d, 1)) inServiceDays++
  // ★ 假期日亦只計在職區間 —— 兩個數要同一個範圍，否則會互相污染
  const leaveDays = [...new Set(a.leaveDates)].filter(d => d >= effStart && d <= effEnd).length
  const expectedMinutes = (inServiceDays - leaveDays) * 9 * 60
  const rosterMinutes = a.rosterMinutes

  // ★ 完全冇排更又冇假 → 「未排更」唔係「欠鐘」
  if (rosterMinutes === 0 && leaveDays === 0) return { expectedMinutes, rosterMinutes: 0, diffMinutes: 0, unscheduled: true }
  return { expectedMinutes, rosterMinutes, diffMinutes: rosterMinutes - expectedMinutes, unscheduled: false }
}

/** 應返 = (曆日 − 當月全部假期日數，按日期去重) × 9；已編班 = 更次跨度（剔走假期日）
 * ★ cwm-money-20260917 P2-5：免考勤員工（attendanceExempt）已由上游 caller（payroll-runs/[id] empIds filter，
 *   cwm-attexempt-20260914）隔走，呢度唔好重複加 attendanceExempt filter。 */
export async function computeRosterHours(
  employeeIds: string[],
  periodMonth: string, // 'YYYY-MM'
  db: any,
  // ★ cwm-resigntb-20261004：lastWorkDay = 最後工作日覆寫（離職結算確認前 DB 未有 resignedAt）
  opts?: { shifts?: any[]; lunchMinutes?: Map<string, number>; lastWorkDay?: Map<string, string> },
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

  const out = new Map<string, { expectedMinutes: number; rosterMinutes: number; diffMinutes: number; unscheduled: boolean }>()
  if (employeeIds.length === 0) return out

  // ★ 在職期間 —— 月中入職／離職唔應該計足一個月
  const emps = await db.employee.findMany({
    where: { id: { in: employeeIds } },
    select: { id: true, joinDate: true, resignedAt: true },
  })
  const empMeta = new Map<string, { joinStr: string | null; lastWorkDayStr: string | null }>()
  for (const e of emps) {
    empMeta.set(e.id, {
      joinStr: e.joinDate ? toHKDateStr(e.joinDate) : null,
      // ★ cwm-rosterjoin：resignedAt = 最後工作日翌日 → −1 日先係最後工作日
      lastWorkDayStr: opts?.lastWorkDay?.get(e.id)
        ?? (e.resignedAt ? toHKDateStr(new Date(e.resignedAt.getTime() - 86400000)) : null),
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
    const lastWork = empMeta.get(empId)?.lastWorkDayStr ?? null
    for (const d of days) {
      if (leaveKeySet.has(`${empId}:${d.date}`)) continue // ★ 假期日唔計
      // ★ cwm-resigntb-20261004：最後工作日之後嘅更唔計（應返都只計到最後工作日；確認離職前嗰啲更仲未取消）
      if (lastWork && d.date > lastWork) continue
      mins += d.hours * 60
    }
    rosterMap.set(empId, Math.round(mins))
  }

  for (const empId of employeeIds) {
    const meta = empMeta.get(empId)
    out.set(empId, computeRosterDiff({
      joinStr: meta?.joinStr ?? null,
      lastWorkDayStr: meta?.lastWorkDayStr ?? null,
      monthStartStr, monthEndStr,
      leaveDates: leaveByEmp.get(empId) ?? [],
      rosterMinutes: rosterMap.get(empId) ?? 0,
    }))
  }
  return out
}
