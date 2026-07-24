import { PrismaClient } from '@prisma/client'
import { toHKDateStr } from './hk-date'

export interface ADWSource {
  periodMonth: string
  source: 'PayrollItem' | 'WageHistory'
  wage: number
  excludedDays: number
  excludedWage: number
  calendarDays: number
}

export interface ADWResult {
  adw: number
  totalWage: number
  totalDays: number
  isShortPeriod: boolean
  periodStart: string
  periodEnd: string
  sources: ADWSource[]
  warnings: string[]
}

/**
 * Calculate EO 713 Average Daily Wage.
 *
 * Legal basis (Labour Department Employment Ordinance Guide):
 * - Use the 12 months before the specified date
 * - If employed < 12 months, use the shorter period
 * - Exclude periods without full wages (rest days, holidays, annual leave,
 *   sick leave, maternity, paternity, work injury, agreed leave, days without work)
 *   along with payments made during those periods
 *
 * @param db PrismaClient instance
 * @param employeeId Employee ID
 * @param specifiedDate The specified date (first day of leave / sick leave / maternity leave)
 */
export async function calculateADW(
  db: PrismaClient,
  employeeId: string,
  specifiedDate: Date,
): Promise<ADWResult> {
  const warnings: string[] = []

  // 1) Get employee join date
  const employee = await db.employee.findUnique({
    where: { id: employeeId },
    select: { joinDate: true },
  })
  if (!employee) throw new Error(`Employee ${employeeId} not found`)

  // 2) Determine calculation period:
  //    periodEnd = specifiedDate - 1 day (in HK time)
  //    12 months before specifiedDate
  //    Use the longer of joinDate vs 12-months-ago as periodStart
  const periodEndStr = toHKDateStr(specifiedDate)
  const [endY, endM, endD] = periodEndStr.split('-').map(Number)
  const periodEnd = new Date(Date.UTC(endY, endM - 1, endD - 1)) // day before specified date

  const twelveMonthsAgo = new Date(periodEnd)
  twelveMonthsAgo.setUTCFullYear(twelveMonthsAgo.getUTCFullYear() - 1)

  const joinDate = new Date(employee.joinDate)
  const joinDateHK = toHKDateStr(joinDate)
  const joinUTC = new Date(Date.UTC(
    parseInt(joinDateHK.split('-')[0]),
    parseInt(joinDateHK.split('-')[1]) - 1,
    parseInt(joinDateHK.split('-')[2]),
  ))

  const isShortPeriod = joinUTC > twelveMonthsAgo
  const periodStart = isShortPeriod ? joinUTC : twelveMonthsAgo

  if (isShortPeriod) {
    warnings.push(
      `受僱不足12個月，以較短期間計算（自 ${joinDateHK} 起）`,
    )
  }

  // 3) Convert to YYYY-MM month strings
  const startMonth = toHKDateStr(periodStart).slice(0, 7)
  const endMonth = toHKDateStr(periodEnd).slice(0, 7)

  // 4) Fetch PayrollItem + WageHistory for the period
  const [payrollItems, wageHistories] = await Promise.all([
    db.payrollItem.findMany({
      where: {
        employeeId,
        run: { periodMonth: { gte: startMonth, lte: endMonth } },
      },
      include: { run: { select: { periodMonth: true } } },
    }),
    db.wageHistory.findMany({
      where: { employeeId, periodMonth: { gte: startMonth, lte: endMonth } },
    }),
  ])

  // 5) Merge: PayrollItem takes priority over WageHistory for same month
  const byMonth = new Map<string, ADWSource>()

  for (const wh of wageHistories) {
    byMonth.set(wh.periodMonth, {
      periodMonth: wh.periodMonth,
      source: 'WageHistory',
      wage: wh.totalWage,
      excludedDays: wh.excludedDays,
      excludedWage: wh.excludedWage,
      calendarDays: wh.calendarDays,
    })
  }

  for (const pi of payrollItems) {
    const pm = (pi.run as { periodMonth: Date | string }).periodMonth
    const pmStr = typeof pm === 'string' ? pm : toHKDateStr(pm).slice(0, 7)
    byMonth.set(pmStr, {
      periodMonth: pmStr,
      source: 'PayrollItem',
      wage: (pi as any).eoWage ?? deriveEoWage(pi as any),
      excludedDays: (pi as any).excludedDays ?? 0,
      excludedWage: (pi as any).excludedWage ?? 0,
      calendarDays: daysInMonth(pmStr),
    })
  }

  const sources = [...byMonth.values()].sort((a, b) =>
    a.periodMonth.localeCompare(b.periodMonth),
  )

  // 6) Data completeness check
  const expectedMonths = monthsBetween(startMonth, endMonth)
  if (sources.length < expectedMonths) {
    warnings.push(
      `期間應有 ${expectedMonths} 個月資料，實際只有 ${sources.length} 個月。` +
      `ADW 可能不準確，建議在「歷史工資」補錄缺少的月份。`,
    )
  }

  // 7) Calculate ADW (numerator and denominator both deduct exclusions)
  const totalWage = sources.reduce((s, x) => s + x.wage - x.excludedWage, 0)
  const totalDays = sources.reduce((s, x) => s + x.calendarDays - x.excludedDays, 0)

  if (totalDays <= 0) {
    warnings.push('可計算日數為 0，無法計算 ADW')
    return {
      adw: 0,
      totalWage: 0,
      totalDays: 0,
      isShortPeriod,
      periodStart: toHKDateStr(periodStart),
      periodEnd: toHKDateStr(periodEnd),
      sources,
      warnings,
    }
  }

  return {
    adw: Math.round((totalWage / totalDays) * 100) / 100,
    totalWage: Math.round(totalWage * 100) / 100,
    totalDays,
    isShortPeriod,
    periodStart: toHKDateStr(periodStart),
    periodEnd: toHKDateStr(periodEnd),
    sources,
    warnings,
  }
}

/**
 * Derive EO wage from PayrollItem when eoWage field is not yet populated.
 *
 * EO wage definition: base pay + OT pay + split pay + store bonus + attendance bonus
 *   minus deductions.
 *   Excludes: misc reimbursement (not wages), employer MPF contributions.
 */
function deriveEoWage(pi: any): number {
  const attendanceBonus = (() => {
    try {
      const detail = pi.detailJson ? JSON.parse(pi.detailJson) : {}
      return detail.attendanceBonus ?? 0
    } catch {
      return 0
    }
  })()

  return (
    (pi.basePay ?? 0) +
    (pi.otPay ?? 0) +
    (pi.splitPay ?? 0) +
    (pi.storeBonus ?? 0) +
    attendanceBonus -
    (pi.deduction ?? 0)
  )
}

/** Days in a month from YYYY-MM string */
function daysInMonth(periodMonth: string): number {
  const [y, m] = periodMonth.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Number of months between two YYYY-MM strings (inclusive) */
function monthsBetween(start: string, end: string): number {
  const [sy, sm] = start.split('-').map(Number)
  const [ey, em] = end.split('-').map(Number)
  return (ey - sy) * 12 + (em - sm) + 1
}

/**
 * When a payroll run is FINALIZED, write EO wage fields back to each PayrollItem.
 *
 * Writes:
 *  - eoWage        = basePay + otPay + splitPay + storeBonus + attendanceBonus - deduction
 *  - excludedDays  = restDays + publicHolidayDays + annualLeaveDays + sickDays + …
 *  - excludedWage  = holidayPay + annualLeavePay + maternityPay + paternityPay + sickAllowance(4/5 portion)
 *
 * Design: does NOT write WageHistory — WageHistory is only for pre-system manual entries.
 * Post-system months are sourced directly from PayrollItem (calculateADW prioritises PayrollItem).
 *
 * Audit: creates a WAGE_SNAPSHOT audit log entry.
 *
 * @param tx          Prisma transaction client
 * @param runId       PayrollRun id
 * @param actorId     user id of the person who finalized the run
 */
export async function snapshotWagesForADW(
  tx: any,
  runId: string,
  actorId: string,
): Promise<void> {
  const run = await tx.payrollRun.findUnique({
    where: { id: runId },
    include: {
      items: {
        include: {
          employee: { select: { id: true, user: { select: { name: true } } } },
        },
      },
    },
  })
  if (!run) return

  const [y, m] = run.periodMonth.split('-').map(Number)
  const calendarDays = new Date(Date.UTC(y, m, 0)).getUTCDate()

  for (const item of run.items) {
    // ── 1) EO wage (excludes misc reimbursement, employer MPF) ──
    const eoWage =
      (item.basePay ?? 0) +
      (item.otPay ?? 0) +
      (item.splitPay ?? 0) +
      (item.storeBonus ?? 0) +
      deriveAttendanceBonusFromDetail(item) -
      (item.deduction ?? 0)

    // ── 2) Excluded days & wage (EO 713) ──
    // The engine writes detailJson with nested keys:
    //   leaveAndOt.monthlyLeaveDays  = rest days + public holidays (entitlement)
    //   leaveAndOt.leaveTaken        = actual leave consumed this month
    //   salary.sickEpisodes          = [{ range, totalDays, daysInMonth, rate }]
    //   salary.sickDeduction         = deduction amount for sick days
    //   Top-level storeBonus, grossPay, mpf, netPay, etc.
    // We approximate excludedDays from available data.
    const detail = safeParseDetail(item.detailJson)
    const leaveAndOt: any = detail.leaveAndOt || {}
    const salary: any = detail.salary || {}

    // restDays + publicHolidayDays = monthlyLeaveDays (entitlement, best available)
    const restAndHolidayDays = leaveAndOt.monthlyLeaveDays ?? 0
    // Leave days actually taken this month
    const leaveTaken = leaveAndOt.leaveTaken ?? (item.leaveDays ?? 0)
    // Sick days: sum daysInMonth from sickEpisodes
    const sickEpisodes: Array<{ daysInMonth?: number; rate?: number }> = salary.sickEpisodes || detail.sickEpisodes || []
    const sickDays = sickEpisodes.reduce((s: number, e: any) => s + (e.daysInMonth ?? 0), 0)
    // Maternity / paternity days (Phase 4: engine writes to detail)
    const maternityDays = (detail as any).maternityDaysInMonth ?? (detail as any).maternityDays ?? 0
    const paternityDays = (detail as any).paternityDaysInMonth ?? (detail as any).paternityDays ?? 0

    const excludedDays = restAndHolidayDays + leaveTaken + sickDays + maternityDays + paternityDays

    // Excluded wage: payments during excluded periods
    // holidayPay + annualLeavePay are part of basePay (already included)
    // sickAllowance 4/5 portion: daily base × 0.8 × sickDays
    const dailyWage = salary.dailyWage ?? ((item.basePay / calendarDays) || 0)
    const sickAllowance4Over5 = sickEpisodes
      .filter((e: any) => e.rate === 0.8)
      .reduce((s: number, e: any) => s + dailyWage * 0.8 * (e.daysInMonth ?? 0), 0)

    const excludedWage =
      ((detail as any).holidayPay ?? 0) +
      ((detail as any).annualLeavePay ?? 0) +
      (item.maternityPay ?? 0) +
      (item.paternityPay ?? 0) +
      sickAllowance4Over5

    await tx.payrollItem.update({
      where: { id: item.id },
      data: {
        eoWage: Math.round(eoWage * 100) / 100,
        excludedDays,
        excludedWage: Math.round(excludedWage * 100) / 100,
      },
    })
  }

  // ── 3) Audit log ──
  await tx.auditLog.create({
    data: {
      actorId,
      action: 'WAGE_SNAPSHOT',
      entity: 'PayrollRun',
      entityId: runId,
      afterJson: JSON.stringify({
        periodMonth: run.periodMonth,
        itemCount: run.items.length,
        calendarDays,
      }),
      notes: `計糧確認，已沉澱 ${run.items.length} 位員工的 ${run.periodMonth} 工資記錄供 ADW 計算`,
    },
  })
}

/** Extract attendanceBonus from detailJson (top-level or nested in salary). */
function deriveAttendanceBonusFromDetail(item: any): number {
  const detail = safeParseDetail(item.detailJson)
  // Top-level first (set by attendance bonus modifier), then salary.attendanceBonus
  return ((detail as any).attendanceBonus ?? (detail as any).salary?.attendanceBonus ?? 0) as number
}

/** Safely parse detailJson; returns {} on error. */
function safeParseDetail(jsonStr: string | null | undefined): Record<string, unknown> {
  if (!jsonStr) return {}
  try { return JSON.parse(jsonStr) } catch { return {} }
}
