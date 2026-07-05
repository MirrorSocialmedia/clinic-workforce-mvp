// ============================================================
// Payroll Engine — Phase 6
// Parametric salary calculation from PayRule.configJson
// Sources: PunchRecord (corrected), LeaveRequest, Shift, HKPublicHoliday
// ============================================================

import { prisma } from './prisma'
import type { PayType, RunStatus } from '@prisma/client'

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface PayRuleConfig {
  // Monthly
  monthly_salary?: number
  deduction_rate?: number       // 0–1, default 1
  ot_multiplier?: number
  ot_threshold?: number         // hours per month, default 174 (26*6.75)

  // Hourly
  hourly_rate?: number
  ot_threshold_daily?: number   // hours per day, default 9

  // Daily
  daily_rate?: number

  // Split (doctor)
  split_ratio?: number          // 0–1
  consultation_target?: number  // target consultations per month
}

interface EmployeePayrollData {
  employeeId: string
  employeeName: string
  clinicIds: string[]           // clinics this employee works at
  payRules: Array<{
    id: string
    payType: PayType
    baseAmount: number | null
    config: PayRuleConfig
    clinicId?: string | null    // which clinic this rule applies to (from EmployeeClinic)
  }>
}

interface PunchDay {
  date: string   // YYYY-MM-DD
  clinicId: string
  clockIn: Date | null
  clockOut: Date | null
  hours: number  // calculated hours for this day
  isLate: boolean
  isAbsent: boolean
}

interface PayrollCalculationResult {
  employeeId: string
  employeeName: string
  payType: PayType
  workedHours: number
  otHours: number
  leaveDays: number
  absentDays: number
  basePay: number
  otPay: number
  splitPay: number | null
  deduction: number
  totalPayable: number
  detail: Record<string, any>
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Get first and last day of a month from a YYYY-MM-01 date */
function getMonthRange(monthDate: Date): { start: Date; end: Date } {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()
  return {
    start: new Date(year, month, 1),
    end: new Date(year, month + 1, 0, 23, 59, 59, 999),
  }
}

/** Count working days in a month (exclude Sat/Sun) */
function countWorkingDays(year: number, month: number): number {
  let count = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const dayOfWeek = new Date(year, month, d).getDay()
    if (dayOfWeek !== 0 && dayOfWeek !== 6) count++
  }
  return count
}

/** Is a date a weekend (Sat=6, Sun=0) */
function isWeekend(date: Date): boolean {
  const dow = date.getDay()
  return dow === 0 || dow === 6
}

/** Format date to YYYY-MM-DD */
function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

/** Parse configJson safely */
function parsePayRuleConfig(configJson: string | null | undefined): PayRuleConfig {
  if (!configJson) return {}
  try {
    return JSON.parse(configJson)
  } catch {
    return {}
  }
}

// ------------------------------------------------------------------
// Punch Record Processing
// ------------------------------------------------------------------

/**
 * Calculate actual worked hours from PunchRecords + APPROVED PunchCorrections.
 * Returns per-day breakdown.
 *
 * Logic:
 * - Group by date + clinic
 * - For each day: find earliest CLOCK_IN and latest CLOCK_OUT
 * - APPROVED corrections override original punch times
 * - Calculate hours = (clockOut - clockIn) / 3600000
 */
async function calculateWorkedHours(
  employeeId: string,
  clinicIds: string[] | null,
  monthStart: Date,
  monthEnd: Date
): Promise<PunchDay[]> {
  // Get all punch records for the period
  const where: any = {
    employeeId,
    punchTime: { gte: monthStart, lte: monthEnd },
  }
  if (clinicIds && clinicIds.length > 0) {
    where.clinicId = { in: clinicIds }
  }

  const [punches, corrections] = await Promise.all([
    prisma.punchRecord.findMany({
      where,
      orderBy: { punchTime: 'asc' },
    }),
    prisma.punchCorrection.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        correctedTime: { gte: monthStart, lte: monthEnd },
      },
    }),
  ])

  // Build a correction map: correction overrides punch for the same day/type
  const correctionMap = new Map<string, Date>() // key: "YYYY-MM-DD:CLOCK_IN|CLOCK_OUT"
  for (const c of corrections) {
    const key = `${formatDate(c.correctedTime)}:${c.punchType}`
    correctionMap.set(key, c.correctedTime)
  }

  // Also add corrections that don't reference a punch record (standalone)
  for (const c of corrections) {
    if (!c.punchRecordId) {
      // Standalone correction — treat as a new punch
      const key = `standalone:${formatDate(c.correctedTime)}:${c.punchType}:${c.clinicId}`
      correctionMap.set(key, c.correctedTime)
    }
  }

  // Group punches by date + clinic
  const dayClinicMap = new Map<string, { clockIns: Date[]; clockOuts: Date[]; clinicId: string }>()

  for (const p of punches) {
    const dayKey = formatDate(p.punchTime)
    const mapKey = `${dayKey}:${p.clinicId}`
    let entry = dayClinicMap.get(mapKey)
    if (!entry) {
      entry = { clockIns: [], clockOuts: [], clinicId: p.clinicId }
      dayClinicMap.set(mapKey, entry)
    }

    if (p.punchType === 'CLOCK_IN') entry.clockIns.push(p.punchTime)
    else entry.clockOuts.push(p.punchTime)
  }

  // Apply corrections: override original times
  for (const [key, correctedTime] of correctionMap) {
    if (key.startsWith('standalone:')) continue // handled separately

    const [dayStr, punchType] = key.split(':')
    const type = punchType === 'CLOCK_IN' ? 'clockIns' : 'clockOuts'

    for (const [mapKey, entry] of dayClinicMap) {
      if (mapKey.startsWith(dayStr)) {
        // Remove original, add corrected
        if (type === 'clockIns') {
          entry.clockIns = entry.clockIns.filter(t => !correctionMap.has(`${dayStr}:CLOCK_IN`) || t.getTime() === correctedTime.getTime())
          entry.clockIns.push(correctedTime)
        } else {
          entry.clockOuts = entry.clockOuts.filter(t => !correctionMap.has(`${dayStr}:CLOCK_OUT`) || t.getTime() === correctedTime.getTime())
          entry.clockOuts.push(correctedTime)
        }
      }
    }
  }

  // Add standalone corrections
  for (const c of corrections) {
    if (!c.punchRecordId) {
      const dayStr = formatDate(c.correctedTime)
      const mapKey = `${dayStr}:${c.clinicId}`
      let entry = dayClinicMap.get(mapKey)
      if (!entry) {
        entry = { clockIns: [], clockOuts: [], clinicId: c.clinicId }
        dayClinicMap.set(mapKey, entry)
      }
      if (c.punchType === 'CLOCK_IN') entry.clockIns.push(c.correctedTime)
      else entry.clockOuts.push(c.correctedTime)
    }
  }

  // Calculate hours per day
  const results: PunchDay[] = []
  for (const [mapKey, entry] of dayClinicMap) {
    const dayStr = mapKey.split(':')[0]
    const clinicId = entry.clinicId

    if (entry.clockIns.length === 0 || entry.clockOuts.length === 0) {
      // Incomplete day — mark as absent or partial
      results.push({
        date: dayStr,
        clinicId,
        clockIn: entry.clockIns[0] || null,
        clockOut: entry.clockOuts[0] || null,
        hours: 0,
        isLate: false,
        isAbsent: true,
      })
      continue
    }

    // Earliest clock-in, latest clock-out
    const clockIn = entry.clockIns.reduce((a, b) => a < b ? a : b)
    const clockOut = entry.clockOuts.reduce((a, b) => a > b ? a : b)
    const hours = Math.max(0, (clockOut.getTime() - clockIn.getTime()) / 3600000)
    // Cap at 24 hours per day
    const cappedHours = Math.min(hours, 24)

    // Check late: clock-in after 9:30 AM (configurable)
    const isLate = clockIn.getHours() > 9 || (clockIn.getHours() === 9 && clockIn.getMinutes() > 30)

    results.push({
      date: dayStr,
      clinicId,
      clockIn,
      clockOut,
      hours: Math.round(cappedHours * 100) / 100,
      isLate,
      isAbsent: false,
    })
  }

  return results
}

// ------------------------------------------------------------------
// Leave Days
// ------------------------------------------------------------------

async function getApprovedLeaveDays(
  employeeId: string,
  monthStart: Date,
  monthEnd: Date
): Promise<{ totalDays: number; byType: Array<{ leaveTypeName: string; days: number; isPaid: boolean }> }> {
  const leaves = await prisma.leaveRequest.findMany({
    where: {
      employeeId,
      status: 'APPROVED',
      startDate: { lte: monthEnd },
      endDate: { gte: monthStart },
    },
    include: {
      leaveType: { select: { name: true, isPaid: true } },
    },
  })

  let totalDays = 0
  const byType: Array<{ leaveTypeName: string; days: number; isPaid: boolean }> = []

  for (const leave of leaves) {
    // Clamp leave period to month range
    const effectiveStart = new Date(Math.max(leave.startDate.getTime(), monthStart.getTime()))
    const effectiveEnd = new Date(Math.min(leave.endDate.getTime(), monthEnd.getTime()))

    // Count working days in the overlap
    let overlapDays = 0
    const current = new Date(effectiveStart)
    while (current <= effectiveEnd) {
      if (!isWeekend(current)) overlapDays++
      current.setDate(current.getDate() + 1)
    }

    totalDays += overlapDays
    byType.push({
      leaveTypeName: leave.leaveType.name,
      days: overlapDays,
      isPaid: leave.leaveType.isPaid,
    })
  }

  return { totalDays, byType }
}

// ------------------------------------------------------------------
// Public Holidays
// ------------------------------------------------------------------

async function getPublicHolidayDays(
  monthStart: Date,
  monthEnd: Date
): Promise<Date[]> {
  const holidays = await prisma.hKPublicHoliday.findMany({
    where: {
      date: { gte: monthStart, lte: monthEnd },
    },
  })

  // Filter to working days only (public holidays on weekends don't count as absent)
  return holidays
    .map(h => new Date(h.date))
    .filter(d => !isWeekend(d))
}

// ------------------------------------------------------------------
// Employee Pay Data
// ------------------------------------------------------------------

async function getEmployeePayData(
  employeeId: string,
  clinicIdFilter: string | null
): Promise<EmployeePayrollData> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: {
      user: { select: { name: true } },
      payRules: {
        where: {
          isActive: true,
          OR: [
            { effectiveTo: null },
            { effectiveTo: { gte: new Date() } },
          ],
        },
      },
      clinics: {
        select: { clinicId: true },
      },
    },
  })

  if (!employee) {
    throw new Error(`Employee ${employeeId} not found`)
  }

  const clinicIds = employee.clinics.map(ec => ec.clinicId)
    .filter(id => !clinicIdFilter || id === clinicIdFilter)

  const payRules = employee.payRules.map(pr => ({
    id: pr.id,
    payType: pr.payType,
    baseAmount: pr.baseAmount,
    config: parsePayRuleConfig(pr.configJson),
  }))

  return {
    employeeId,
    employeeName: employee.user.name,
    clinicIds,
    payRules,
  }
}

// ------------------------------------------------------------------
// Core Calculation
// ------------------------------------------------------------------

function calculateMonthly(
  config: PayRuleConfig,
  workingDays: number,
  actualAttendanceDays: number,
  approvedLeaveDays: number,
  paidLeaveDays: number,
  publicHolidayDays: number,
  totalHours: number,
  monthStart: Date
): Pick<PayrollCalculationResult, 'basePay' | 'otPay' | 'deduction' | 'detail'> {
  const monthlySalary = config.monthly_salary || 0
  const deductionRate = config.deduction_rate ?? 1
  const otMultiplier = config.ot_multiplier ?? 1.5
  const otThreshold = config.ot_threshold ?? 174 // 26 days * 6.75 hours

  // Only unpaid leave counts toward absence
  const unpaidLeaveDays = approvedLeaveDays - paidLeaveDays
  const publicHolidaysOnWorkingDays = publicHolidayDays

  // Absent days = working days - actual attendance days - unpaid leave - public holidays
  // Paid leave doesn't count as absence
  const absentDays = Math.max(
    0,
    workingDays - actualAttendanceDays - unpaidLeaveDays - publicHolidaysOnWorkingDays
  )

  const basePay = monthlySalary
  const deduction = absentDays * (monthlySalary / 26) * deductionRate

  // Overtime: hours beyond threshold
  const otHours = Math.max(0, totalHours - otThreshold)
  const hourlyEquivalent = monthlySalary / otThreshold
  const otPay = otHours * hourlyEquivalent * otMultiplier

  return {
    basePay,
    otPay,
    deduction,
    detail: {
      payType: 'MONTHLY',
      monthlySalary,
      workingDays,
      actualAttendanceDays,
      approvedLeaveDays,
      paidLeaveDays,
      unpaidLeaveDays,
      publicHolidayDays,
      absentDays,
      deductionRate,
      otThreshold,
      otHours,
      hourlyEquivalent,
      otMultiplier,
    },
  }
}

function calculateHourly(
  config: PayRuleConfig,
  totalHours: number,
): Pick<PayrollCalculationResult, 'basePay' | 'otPay' | 'detail'> {
  const hourlyRate = config.hourly_rate || 0
  const otMultiplier = config.ot_multiplier ?? 1.5
  const otThresholdDaily = config.ot_threshold_daily ?? 9

  // For hourly, we need per-day OT calculation
  // Simplified: if total hours exceed threshold proportionally
  // Proper OT would need per-day data; for now use a monthly threshold
  const otThresholdMonthly = otThresholdDaily * 26 // approximate

  const normalHours = Math.min(totalHours, otThresholdMonthly)
  const otHours = Math.max(0, totalHours - otThresholdMonthly)

  const basePay = normalHours * hourlyRate
  const otPay = otHours * hourlyRate * otMultiplier

  return {
    basePay,
    otPay,
    detail: {
      payType: 'HOURLY',
      hourlyRate,
      totalHours,
      normalHours,
      otHours,
      otThresholdDaily,
      otThresholdMonthly,
      otMultiplier,
    },
  }
}

function calculateDaily(
  config: PayRuleConfig,
  attendanceDays: number,
  totalHours: number,
): Pick<PayrollCalculationResult, 'basePay' | 'otPay' | 'detail'> {
  const dailyRate = config.daily_rate || 0
  const otMultiplier = config.ot_multiplier ?? 1.5
  const dailyHoursThreshold = config.ot_threshold_daily ?? 9

  const basePay = attendanceDays * dailyRate

  // OT: simplified — if average hours/day > threshold
  const avgHoursPerDay = attendanceDays > 0 ? totalHours / attendanceDays : 0
  const otHours = attendanceDays * Math.max(0, avgHoursPerDay - dailyHoursThreshold)
  const hourlyEquivalent = dailyRate / dailyHoursThreshold
  const otPay = otHours * hourlyEquivalent * otMultiplier

  return {
    basePay,
    otPay,
    detail: {
      payType: 'DAILY',
      dailyRate,
      attendanceDays,
      totalHours,
      avgHoursPerDay,
      otHours,
      otMultiplier,
    },
  }
}

function calculateSplit(
  config: PayRuleConfig,
  basePay: number,
  // consultationFees would come from a separate source (e.g., clinic billing)
  // For MVP, we read from config or set to 0
  consultationFees?: number,
): Pick<PayrollCalculationResult, 'basePay' | 'splitPay' | 'detail'> {
  const splitRatio = config.split_ratio ?? 0
  const fees = consultationFees ?? config.consultation_target ?? 0

  const splitPay = fees * splitRatio

  return {
    basePay,
    splitPay,
    detail: {
      payType: 'SPLIT',
      splitRatio,
      consultationFees: fees,
      splitPay,
    },
  }
}

// ------------------------------------------------------------------
// Main Calculate Function
// ------------------------------------------------------------------

/**
 * Calculate payroll for a single employee for a given month.
 * Handles cross-clinic merging (sums hours/pay from all clinics).
 */
async function calculateEmployeePayroll(
  employeeId: string,
  periodMonth: Date,
  clinicIdFilter: string | null
): Promise<PayrollCalculationResult> {
  const { start: monthStart, end: monthEnd } = getMonthRange(periodMonth)
  const year = periodMonth.getFullYear()
  const month = periodMonth.getMonth()

  const payData = await getEmployeePayData(employeeId, clinicIdFilter)

  // Get worked hours from all applicable clinics
  const allPunchDays = await calculateWorkedHours(
    employeeId,
    clinicIdFilter ? [clinicIdFilter] : payData.clinicIds.length > 0 ? payData.clinicIds : null,
    monthStart,
    monthEnd
  )

  // Merge hours across clinics for the same day
  const dayHoursMap = new Map<string, number>()
  let totalWorkedHours = 0
  const attendanceDaysSet = new Set<string>()

  for (const pd of allPunchDays) {
    const existing = dayHoursMap.get(pd.date) || 0
    dayHoursMap.set(pd.date, existing + pd.hours)
    totalWorkedHours += pd.hours
    if (pd.hours > 0) attendanceDaysSet.add(pd.date)
  }

  const actualAttendanceDays = attendanceDaysSet.size

  // Get approved leave
  const { totalDays: approvedLeaveDays, byType: leaveByType } =
    await getApprovedLeaveDays(employeeId, monthStart, monthEnd)

  // Paid leave days
  const paidLeaveDays = leaveByType.reduce((sum, lt) => sum + (lt.isPaid ? lt.days : 0), 0)

  // Public holidays
  const publicHolidays = await getPublicHolidayDays(monthStart, monthEnd)
  const publicHolidayDays = publicHolidays.length

  // Working days in month
  const workingDays = countWorkingDays(year, month)

  // Determine primary pay type (first active rule)
  const primaryRule = payData.payRules[0]
  if (!primaryRule) {
    return {
      employeeId,
      employeeName: payData.employeeName,
      payType: 'MONTHLY' as PayType,
      workedHours: totalWorkedHours,
      otHours: 0,
      leaveDays: approvedLeaveDays,
      absentDays: 0,
      basePay: 0,
      otPay: 0,
      splitPay: null,
      deduction: 0,
      totalPayable: 0,
      detail: { error: 'No active pay rule found' },
    }
  }

  const config = primaryRule.config
  const payType = primaryRule.payType

  let result: Partial<PayrollCalculationResult>

  switch (payType) {
    case 'MONTHLY': {
      const calc = calculateMonthly(
        config, workingDays, actualAttendanceDays,
        approvedLeaveDays, paidLeaveDays, publicHolidayDays,
        totalWorkedHours, monthStart
      )
      const absentDays = calc.detail.absentDays ?? 0
      const otHours = calc.detail.otHours ?? 0
      result = {
        ...calc,
        absentDays,
        otHours,
        totalPayable: calc.basePay - calc.deduction + calc.otPay,
      }
      break
    }

    case 'HOURLY': {
      const calc = calculateHourly(config, totalWorkedHours)
      const otHours = calc.detail.otHours ?? 0
      result = {
        ...calc,
        otHours,
        absentDays: 0,
        totalPayable: calc.basePay + calc.otPay,
      }
      break
    }

    case 'DAILY': {
      const calc = calculateDaily(config, actualAttendanceDays, totalWorkedHours)
      const otHours = 0 // OT handled in daily calc
      result = {
        ...calc,
        otHours,
        absentDays: 0,
        totalPayable: calc.basePay + calc.otPay,
      }
      break
    }

    case 'SPLIT': {
      // For split, base pay could be monthly or 0
      const basePay = config.monthly_salary ?? 0
      const calc = calculateSplit(config, basePay)

      // Also calculate absence deduction if there's a monthly component
      let deduction = 0
      if (basePay > 0) {
        const unpaidLeaveDays = approvedLeaveDays - paidLeaveDays
        const absentDays = Math.max(
          0,
          workingDays - actualAttendanceDays - unpaidLeaveDays - publicHolidayDays
        )
        deduction = absentDays * (basePay / 26) * (config.deduction_rate ?? 1)
      }

      result = {
        ...calc,
        deduction,
        absentDays: 0,
        otHours: 0,
        totalPayable: calc.basePay - deduction + (calc.splitPay ?? 0),
      }
      break
    }

    default:
      result = {
        basePay: 0, otPay: 0, splitPay: null, deduction: 0, absentDays: 0,
        totalPayable: 0, detail: { error: `Unknown pay type: ${payType}` },
      }
  }

  return {
    employeeId,
    employeeName: payData.employeeName,
    payType,
    workedHours: Math.round(totalWorkedHours * 100) / 100,
    otHours: Math.round((result.otHours ?? 0) * 100) / 100,
    leaveDays: Math.round(approvedLeaveDays * 100) / 100,
    absentDays: Math.round((result.absentDays ?? 0) * 100) / 100,
    basePay: Math.round((result.basePay ?? 0) * 100) / 100,
    otPay: Math.round((result.otPay ?? 0) * 100) / 100,
    splitPay: result.splitPay != null ? Math.round(result.splitPay * 100) / 100 : null,
    deduction: Math.round((result.deduction ?? 0) * 100) / 100,
    totalPayable: Math.round((result.totalPayable ?? 0) * 100) / 100,
    detail: result.detail || {},
  }
}

// ------------------------------------------------------------------
// Full Payroll Run
// ------------------------------------------------------------------

/**
 * Generate a full payroll run. Creates PayrollRun + PayrollItem records.
 */
export async function generatePayrollRun(
  clinicId: string | null,
  periodMonth: string // YYYY-MM format
): Promise<{ runId: string; itemCount: number; totalPayable: number }> {
  const monthDate = new Date(`${periodMonth}-01T00:00:00`)

  // Check for existing run
  const existing = await prisma.payrollRun.findFirst({
    where: {
      clinicId,
      periodMonth: monthDate,
    },
  })

  if (existing) {
    throw new Error(`Payroll run already exists for ${periodMonth}${clinicId ? ` at clinic ${clinicId}` : ' (all clinics)'}`)
  }

  // Create the run
  const run = await prisma.payrollRun.create({
    data: {
      clinicId,
      periodMonth: monthDate,
      status: 'DRAFT' as RunStatus,
    },
  })

  // Get all active employees (optionally filtered by clinic)
  const where: any = { status: 'ACTIVE' }
  if (clinicId) {
    where.clinics = { some: { clinicId } }
  }

  const employees = await prisma.employee.findMany({
    where,
    include: {
      user: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  })

  // Calculate payroll for each employee
  const items: Array<any> = []
  for (const emp of employees) {
    try {
      const result = await calculateEmployeePayroll(emp.id, monthDate, clinicId)
      items.push({
        runId: run.id,
        employeeId: emp.id,
        workedHours: result.workedHours,
        otHours: result.otHours,
        leaveDays: result.leaveDays,
        absentDays: result.absentDays,
        basePay: result.basePay,
        otPay: result.otPay,
        splitPay: result.splitPay,
        deduction: result.deduction,
        totalPayable: result.totalPayable,
        detailJson: JSON.stringify(result.detail),
      })
    } catch (err) {
      console.error(`Failed to calculate payroll for employee ${emp.id}:`, err)
      // Create item with zero values and error in detail
      items.push({
        runId: run.id,
        employeeId: emp.id,
        workedHours: 0,
        otHours: 0,
        leaveDays: 0,
        absentDays: 0,
        basePay: 0,
        otPay: 0,
        splitPay: null,
        deduction: 0,
        totalPayable: 0,
        detailJson: JSON.stringify({ error: String(err) }),
      })
    }
  }

  // Create items in batch
  if (items.length > 0) {
    await prisma.payrollItem.createMany({ data: items })
  }

  const totalPayable = items.reduce((sum, item) => sum + item.totalPayable, 0)

  return {
    runId: run.id,
    itemCount: items.length,
    totalPayable: Math.round(totalPayable * 100) / 100,
  }
}

// Export for testing
export {
  calculateEmployeePayroll,
  calculateWorkedHours,
  getApprovedLeaveDays,
  getPublicHolidayDays,
  getEmployeePayData,
  parsePayRuleConfig,
  countWorkingDays,
  getMonthRange,
  formatDate,
}
