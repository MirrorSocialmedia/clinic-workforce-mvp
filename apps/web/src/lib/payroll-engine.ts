// ============================================================
// Payroll Engine — Phase 6 (Audit-Fixed)
// Parametric salary calculation from PayRule.configJson
// Sources: PunchRecord (corrected), LeaveRequest, Shift, HKPublicHoliday
// Fixes: paired hours, cross-clinic OT, clinicId corrections,
//        single-punch pending, parametric OT thresholds,
//        consultation revenue lookup
// ============================================================

import { prisma } from './prisma'
import type { PayType, RunStatus } from '@prisma/client'

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface PayRuleConfig {
  monthly_salary?: number
  deduction_rate?: number       // 0–1, default 1
  ot_multiplier?: number
  ot_threshold?: number         // hours per month — REQUIRED, no default
  hourly_rate?: number
  ot_threshold_daily?: number   // hours per day — REQUIRED for HOURLY/DAILY, no default
  daily_rate?: number
  split_ratio?: number          // 0–1
  consultation_target?: number  // target (informational only — actual from ConsultationRevenue)
}

interface PayrollCalcDetail {
  payType: PayType
  [key: string]: any
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
  detail: PayrollCalcDetail
}

interface AuditCtx {
  actorId: string
  ip?: string
  ua?: string
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function getMonthRange(monthDate: Date): { start: Date; end: Date } {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()
  return {
    start: new Date(year, month, 1),
    end: new Date(year, month + 1, 0, 23, 59, 59, 999),
  }
}

function countWorkingDays(year: number, month: number): number {
  let count = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const dayOfWeek = new Date(year, month, d).getDay()
    if (dayOfWeek !== 0 && dayOfWeek !== 6) count++
  }
  return count
}

function isWeekend(date: Date): boolean {
  const dow = date.getDay()
  return dow === 0 || dow === 6
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

function parsePayRuleConfig(configJson: string | null | undefined): PayRuleConfig {
  if (!configJson) return {}
  try {
    return JSON.parse(configJson)
  } catch {
    return {}
  }
}

/**
 * Get OT threshold from config — no magic defaults.
 * Throws if not configured.
 */
function getOtThreshold(config: PayRuleConfig, payType: PayType): number {
  if (payType === 'MONTHLY') {
    if (config.ot_threshold === undefined || config.ot_threshold === null) {
      throw new Error(`MONTHLY pay rule missing ot_threshold in configJson`)
    }
    return config.ot_threshold
  }
  // HOURLY or DAILY
  if (config.ot_threshold_daily === undefined || config.ot_threshold_daily === null) {
    throw new Error(`${payType} pay rule missing ot_threshold_daily in configJson`)
  }
  return config.ot_threshold_daily
}

// ------------------------------------------------------------------
// Punch Record Processing — FIX: paired in-out + clinicId corrections
// ------------------------------------------------------------------

/**
 * Calculate actual worked hours from PunchRecords + APPROVED PunchCorrections.
 * FIX #6: Pair in-out segments instead of max(out) - min(in).
 * FIX #5: Correction key includes clinicId to distinguish cross-clinic.
 * FIX #14: Single punch → PENDING_CORRECTION, not absent.
 */
async function calculateWorkedHours(
  employeeId: string,
  clinicIds: string[] | null,
  monthStart: Date,
  monthEnd: Date
): Promise<Array<{
  date: string
  clinicId: string
  hours: number
  isAbsent: boolean
  isPartial: boolean   // single punch without pair
  punches: Array<{ type: string; time: Date }>
}>> {
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

  // Build correction map keyed by day:clinicId:type (FIX #5: include clinicId)
  const correctionMap = new Map<string, Date>()
  for (const c of corrections) {
    const dayStr = formatDate(c.correctedTime)
    // FIX #5: key includes clinicId to distinguish cross-clinic corrections
    const key = `${dayStr}:${c.clinicId}:${c.punchType}`
    correctionMap.set(key, c.correctedTime)
  }

  // Group punches by date + clinic
  interface DayClinicEntry {
    clinicId: string
    punchIns: Date[]
    punchOuts: Date[]
  }
  const dayClinicMap = new Map<string, DayClinicEntry>()

  for (const p of punches) {
    const dayKey = formatDate(p.punchTime)
    const mapKey = `${dayKey}:${p.clinicId}`
    let entry = dayClinicMap.get(mapKey)
    if (!entry) {
      entry = { clinicId: p.clinicId, punchIns: [], punchOuts: [] }
      dayClinicMap.set(mapKey, entry)
    }
    if (p.punchType === 'CLOCK_IN') entry.punchIns.push(p.punchTime)
    else entry.punchOuts.push(p.punchTime)
  }

  // Apply corrections
  for (const [key, correctedTime] of correctionMap) {
    const parts = key.split(':')
    const dayStr = parts[0]
    const clinicId = parts[1]
    const punchType = parts[2]

    const mapKey = `${dayStr}:${clinicId}`
    let entry = dayClinicMap.get(mapKey)
    if (!entry) {
      entry = { clinicId, punchIns: [], punchOuts: [] }
      dayClinicMap.set(mapKey, entry)
    }

    const arr = punchType === 'CLOCK_IN' ? entry.punchIns : entry.punchOuts
    // Replace existing entries of same type with corrected time
    arr.length = 0
    arr.push(correctedTime)
  }

  // FIX #6: Pair in-out segments per day+clinic, sum each segment
  const results: Array<{
    date: string
    clinicId: string
    hours: number
    isAbsent: boolean
    isPartial: boolean
    punches: Array<{ type: string; time: Date }>
  }> = []

  for (const [mapKey, entry] of dayClinicMap) {
    const dayStr = mapKey.split(':')[0]
    const clinicId = entry.clinicId

    const allPunches = [
      ...entry.punchIns.map(t => ({ type: 'CLOCK_IN', time: t })),
      ...entry.punchOuts.map(t => ({ type: 'CLOCK_OUT', time: t })),
    ].sort((a, b) => a.time.getTime() - b.time.getTime())

    // FIX #6: Pair in-out segments
    let totalMs = 0
    let lastIn: Date | null = null

    for (const p of allPunches) {
      if (p.type === 'CLOCK_IN') {
        lastIn = p.time
      } else if (p.type === 'CLOCK_OUT' && lastIn) {
        totalMs += p.time.getTime() - lastIn.getTime()
        lastIn = null
      }
    }

    const hours = Math.min(Math.max(0, totalMs / 3600000), 24)

    // FIX #14: Single punch → PENDING, not absent
    const hasIn = entry.punchIns.length > 0
    const hasOut = entry.punchOuts.length > 0
    const isPartial = (hasIn && !hasOut) || (!hasIn && hasOut)

    let isAbsent = false
    if (!hasIn && !hasOut) {
      // No punches at all → absent
      isAbsent = true
    } else if (isPartial) {
      // Single punch → partial/pending, NOT absent
      // The payroll engine will flag this for review
    }

    results.push({
      date: dayStr,
      clinicId,
      hours: Math.round(hours * 100) / 100,
      isAbsent,
      isPartial,
      punches: allPunches,
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
    const effectiveStart = new Date(Math.max(leave.startDate.getTime(), monthStart.getTime()))
    const effectiveEnd = new Date(Math.min(leave.endDate.getTime(), monthEnd.getTime()))

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
    where: { date: { gte: monthStart, lte: monthEnd } },
  })
  return holidays.map(h => new Date(h.date)).filter(d => !isWeekend(d))
}

// ------------------------------------------------------------------
// Employee Pay Data
// ------------------------------------------------------------------

async function getEmployeePayData(
  employeeId: string,
  clinicIdFilter: string | null
): Promise<{
  employeeId: string
  employeeName: string
  clinicIds: string[]
  payRules: Array<{
    id: string
    payType: PayType
    baseAmount: number | null
    config: PayRuleConfig
  }>
}> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: {
      user: { select: { name: true } },
      payRules: {
        where: {
          isActive: true,
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
        },
      },
      clinics: { select: { clinicId: true } },
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

  return { employeeId, employeeName: employee.user.name, clinicIds, payRules }
}

// ------------------------------------------------------------------
// FIX #4: Cross-clinic OT — per-day split
// ------------------------------------------------------------------

interface DailyHoursEntry {
  date: string
  totalHours: number
  byClinic: Map<string, number>
}

function aggregateDailyHours(punchDays: Awaited<ReturnType<typeof calculateWorkedHours>>): DailyHoursEntry[] {
  const dayMap = new Map<string, DailyHoursEntry>()

  for (const pd of punchDays) {
    let entry = dayMap.get(pd.date)
    if (!entry) {
      entry = { date: pd.date, totalHours: 0, byClinic: new Map() }
      dayMap.set(pd.date, entry)
    }
    entry.totalHours += pd.hours
    const existingClinic = entry.byClinic.get(pd.clinicId) || 0
    entry.byClinic.set(pd.clinicId, existingClinic + pd.hours)
  }

  return Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date))
}

// ------------------------------------------------------------------
// Calculation Functions
// ------------------------------------------------------------------

function calculateMonthly(
  config: PayRuleConfig,
  workingDays: number,
  actualAttendanceDays: number,
  approvedLeaveDays: number,
  paidLeaveDays: number,
  publicHolidayDays: number,
  totalHours: number,
  otThreshold: number
): { basePay: number; otPay: number; deduction: number; detail: PayrollCalcDetail; otHours: number; absentDays: number } {
  const monthlySalary = config.monthly_salary || 0
  const deductionRate = config.deduction_rate ?? 1
  const otMultiplier = config.ot_multiplier ?? 1.5

  const unpaidLeaveDays = approvedLeaveDays - paidLeaveDays
  const absentDays = Math.max(
    0,
    workingDays - actualAttendanceDays - unpaidLeaveDays - publicHolidayDays
  )

  const basePay = monthlySalary
  const deduction = absentDays * (monthlySalary / 26) * deductionRate

  // FIX #7: OT threshold from config, no default
  const otHours = Math.max(0, totalHours - otThreshold)
  const hourlyEquivalent = otThreshold > 0 ? monthlySalary / otThreshold : 0
  const otPay = otHours * hourlyEquivalent * otMultiplier

  return {
    basePay,
    otPay,
    deduction,
    otHours,
    absentDays,
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
  dailyEntries: DailyHoursEntry[],
  otThresholdDaily: number
): { basePay: number; otPay: number; detail: PayrollCalcDetail; otHours: number; totalHours: number } {
  const hourlyRate = config.hourly_rate || 0
  const otMultiplier = config.ot_multiplier ?? 1.5

  let totalNormalHours = 0
  let totalOtHours = 0

  // FIX #4: Per-day OT calculation
  for (const entry of dailyEntries) {
    const normal = Math.min(entry.totalHours, otThresholdDaily)
    const ot = Math.max(0, entry.totalHours - otThresholdDaily)
    totalNormalHours += normal
    totalOtHours += ot
  }

  const basePay = totalNormalHours * hourlyRate
  const otPay = totalOtHours * hourlyRate * otMultiplier

  return {
    basePay,
    otPay,
    otHours: totalOtHours,
    totalHours: totalNormalHours + totalOtHours,
    detail: {
      payType: 'HOURLY',
      hourlyRate,
      totalNormalHours,
      otHours: totalOtHours,
      otThresholdDaily,
      otMultiplier,
    },
  }
}

function calculateDaily(
  config: PayRuleConfig,
  attendanceDays: number,
  dailyEntries: DailyHoursEntry[],
  otThresholdDaily: number
): { basePay: number; otPay: number; detail: PayrollCalcDetail; otHours: number; totalHours: number } {
  const dailyRate = config.daily_rate || 0
  const otMultiplier = config.ot_multiplier ?? 1.5

  const basePay = attendanceDays * dailyRate

  // FIX #4: Per-day OT
  let totalOtHours = 0
  let totalHours = 0
  for (const entry of dailyEntries) {
    totalHours += entry.totalHours
    const ot = Math.max(0, entry.totalHours - otThresholdDaily)
    totalOtHours += ot
  }

  const hourlyEquivalent = otThresholdDaily > 0 ? dailyRate / otThresholdDaily : 0
  const otPay = totalOtHours * hourlyEquivalent * otMultiplier

  return {
    basePay,
    otPay,
    otHours: totalOtHours,
    totalHours,
    detail: {
      payType: 'DAILY',
      dailyRate,
      attendanceDays,
      totalHours,
      otHours: totalOtHours,
      otThresholdDaily,
      otMultiplier,
    },
  }
}

// ------------------------------------------------------------------
// FIX #8: Consultation revenue lookup (actual, not target)
// ------------------------------------------------------------------

async function getConsultationRevenue(
  employeeId: string,
  clinicId: string | null,
  periodMonth: Date
): Promise<number> {
  try {
    const where: any = { employeeId, month: periodMonth }
    if (clinicId) where.clinicId = clinicId

    const record = await prisma.consultationRevenue.findFirst({ where })
    return record ? record.amount : 0
  } catch {
    // ConsultationRevenue table may not exist yet (migration pending)
    return 0
  }
}

function calculateSplit(
  config: PayRuleConfig,
  basePay: number,
  consultationFees: number
): { basePay: number; splitPay: number; detail: PayrollCalcDetail } {
  const splitRatio = config.split_ratio ?? 0
  const splitPay = consultationFees * splitRatio

  return {
    basePay,
    splitPay,
    detail: {
      payType: 'SPLIT',
      splitRatio,
      consultationFees,
      splitPay,
    },
  }
}

// ------------------------------------------------------------------
// Main Calculate Function
// ------------------------------------------------------------------

async function calculateEmployeePayroll(
  employeeId: string,
  periodMonth: Date,
  clinicIdFilter: string | null
): Promise<PayrollCalculationResult> {
  const { start: monthStart, end: monthEnd } = getMonthRange(periodMonth)
  const year = periodMonth.getFullYear()
  const month = periodMonth.getMonth()

  const payData = await getEmployeePayData(employeeId, clinicIdFilter)

  const allPunchDays = await calculateWorkedHours(
    employeeId,
    clinicIdFilter ? [clinicIdFilter] : (payData.clinicIds.length > 0 ? payData.clinicIds : null),
    monthStart,
    monthEnd
  )

  // FIX #4: Aggregate daily hours across clinics
  const dailyEntries = aggregateDailyHours(allPunchDays)

  let totalWorkedHours = 0
  const attendanceDaysSet = new Set<string>()
  const partialDays: string[] = []

  for (const pd of allPunchDays) {
    totalWorkedHours += pd.hours
    if (pd.hours > 0) attendanceDaysSet.add(pd.date)
    if (pd.isPartial) partialDays.push(pd.date)
  }

  const actualAttendanceDays = attendanceDaysSet.size

  const { totalDays: approvedLeaveDays, byType: leaveByType } =
    await getApprovedLeaveDays(employeeId, monthStart, monthEnd)

  const paidLeaveDays = leaveByType.reduce((sum, lt) => sum + (lt.isPaid ? lt.days : 0), 0)

  const publicHolidays = await getPublicHolidayDays(monthStart, monthEnd)
  const publicHolidayDays = publicHolidays.length

  const workingDays = countWorkingDays(year, month)

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
      basePay: 0, otPay: 0, splitPay: null, deduction: 0, totalPayable: 0,
      detail: { error: 'No active pay rule found', partialDays },
    }
  }

  const config = primaryRule.config
  const payType = primaryRule.payType

  let result: Partial<PayrollCalculationResult>

  switch (payType) {
    case 'MONTHLY': {
      const otThreshold = getOtThreshold(config, 'MONTHLY')
      const calc = calculateMonthly(
        config, workingDays, actualAttendanceDays,
        approvedLeaveDays, paidLeaveDays, publicHolidayDays,
        totalWorkedHours, otThreshold
      )
      result = {
        ...calc,
        totalPayable: calc.basePay - calc.deduction + calc.otPay,
        detail: { ...calc.detail, partialDays },
      }
      break
    }

    case 'HOURLY': {
      const otThresholdDaily = getOtThreshold(config, 'HOURLY')
      const calc = calculateHourly(config, dailyEntries, otThresholdDaily)
      result = {
        ...calc,
        absentDays: 0,
        totalPayable: calc.basePay + calc.otPay,
        detail: { ...calc.detail, partialDays },
      }
      break
    }

    case 'DAILY': {
      const otThresholdDaily = getOtThreshold(config, 'DAILY')
      const calc = calculateDaily(config, actualAttendanceDays, dailyEntries, otThresholdDaily)
      result = {
        ...calc,
        absentDays: 0,
        totalPayable: calc.basePay + calc.otPay,
        detail: { ...calc.detail, partialDays },
      }
      break
    }

    case 'SPLIT': {
      // FIX #8: Use actual consultation revenue
      const consultationFees = await getConsultationRevenue(
        employeeId, clinicIdFilter, periodMonth
      )
      const basePay = config.monthly_salary ?? 0
      const calc = calculateSplit(config, basePay, consultationFees)

      let deduction = 0
      if (basePay > 0) {
        const unpaidLeaveDays = approvedLeaveDays - paidLeaveDays
        const absentDays = Math.max(0, workingDays - actualAttendanceDays - unpaidLeaveDays - publicHolidayDays)
        deduction = absentDays * (basePay / 26) * (config.deduction_rate ?? 1)
      }

      result = {
        ...calc,
        deduction,
        absentDays: 0,
        otHours: 0,
        totalPayable: calc.basePay - deduction + calc.splitPay,
        detail: { ...calc.detail, partialDays },
      }
      break
    }

    default:
      result = {
        basePay: 0, otPay: 0, splitPay: null, deduction: 0, absentDays: 0,
        totalPayable: 0, detail: { error: `Unknown pay type: ${payType}` } as PayrollCalcDetail,
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
    detail: result.detail || ({} as PayrollCalcDetail),
  }
}

// ------------------------------------------------------------------
// Full Payroll Run
// ------------------------------------------------------------------

export async function generatePayrollRun(
  clinicId: string | null,
  periodMonth: string,
  auditCtx?: AuditCtx
): Promise<{ runId: string; itemCount: number; totalPayable: number }> {
  const monthDate = new Date(`${periodMonth}-01T00:00:00`)

  const existing = await prisma.payrollRun.findFirst({
    where: { clinicId, periodMonth: monthDate },
  })

  if (existing) {
    throw new Error(`Payroll run already exists for ${periodMonth}`)
  }

  // Create run
  const run = await prisma.payrollRun.create({
    data: { clinicId, periodMonth: monthDate, status: 'DRAFT' as RunStatus },
  })

  const where: any = { status: 'ACTIVE' }
  if (clinicId) where.clinics = { some: { clinicId } }

  const employees = await prisma.employee.findMany({
    where,
    include: { user: { select: { name: true } } },
    orderBy: { id: 'asc' },
  })

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
      console.error(`Failed payroll for ${emp.id}:`, err)
      items.push({
        runId: run.id,
        employeeId: emp.id,
        workedHours: 0, otHours: 0, leaveDays: 0, absentDays: 0,
        basePay: 0, otPay: 0, splitPay: null, deduction: 0, totalPayable: 0,
        detailJson: JSON.stringify({ error: String(err) }),
      })
    }
  }

  if (items.length > 0) {
    await prisma.payrollItem.createMany({ data: items })
  }

  // Audit log
  if (auditCtx?.actorId) {
    await prisma.auditLog.create({
      data: {
        actorId: auditCtx.actorId,
        action: 'CREATE_PAYROLL_RUN',
        entity: 'PayrollRun',
        entityId: run.id,
        notes: `Generated payroll for ${periodMonth}: ${items.length} employees`,
        ipAddress: auditCtx.ip || null,
        userAgent: auditCtx.ua || null,
      },
    })
  }

  const totalPayable = items.reduce((sum, item) => sum + item.totalPayable, 0)

  return { runId: run.id, itemCount: items.length, totalPayable: Math.round(totalPayable * 100) / 100 }
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
  getOtThreshold,
  aggregateDailyHours,
}
