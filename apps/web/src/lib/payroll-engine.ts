// ============================================================
// Payroll Engine — Phase 6 (Audit-Fixed)
// Parametric salary calculation from PayRule.configJson
// Sources: PunchRecord (corrected), LeaveRequest, Shift, HKPublicHoliday
// Fixes: paired hours, cross-clinic OT, clinicId corrections,
//        single-punch pending, parametric OT thresholds,
//        consultation revenue lookup
// ============================================================

import { prisma, basePrisma } from './prisma'
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
  // TODO: strict types — replace with concrete fields or Record<string, unknown>
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
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
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
  // TODO: strict types
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
    // TODO: strict types
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
      detail: { payType: 'MONTHLY' as PayType, error: 'No active pay rule found', partialDays },
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
        totalPayable: 0, detail: { payType, error: `Unknown pay type: ${payType}` } as PayrollCalcDetail,
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
): Promise<
  | { runId: string; itemCount: number; totalPayable: number }
  | { error: string; runId: string; status: string }
> {
  // Parse YYYY-MM → Date using local (HK) time, no UTC confusion
  const [yearStr, monthStr] = periodMonth.split('-')
  const monthDate = new Date(parseInt(yearStr), parseInt(monthStr) - 1, 1)

  const { start: monthStart, end: monthEnd } = getMonthRange(monthDate)

  const existing = await prisma.payrollRun.findFirst({
    where: { clinicId, periodMonth: monthDate },
  })

  // FIX #2: Handle recalculation
  let run: any = existing
  const isRecalculation = !!existing
  if (existing) {
    // CONFIRMED (FINALIZED/EXPORTED) — block recalculation
    if (existing.status === 'FINALIZED' || existing.status === 'EXPORTED') {
      return {
        error: '該月已確認出糧，需先解除確認才能重算',
        runId: existing.id,
        status: existing.status,
      }
    }
    // DRAFT — allow recalculation: delete old items
    await prisma.payrollItem.deleteMany({ where: { runId: existing.id } })
  }

  // FIX #5: Include resigned employees who have activity in the month
  // Include: ACTIVE + those with PunchRecord or Shift in the period
  const where: any = {
    OR: [
      { status: 'ACTIVE' },
      {
        punches: {
          some: {
            punchTime: { gte: monthStart, lte: monthEnd },
          },
        },
      },
      {
        shifts: {
          some: {
            date: { gte: monthStart, lte: monthEnd },
          },
        },
      },
    ],
  }
  if (clinicId) where.clinics = { some: { clinicId } }

  const employees = await prisma.employee.findMany({
    where,
    include: { user: { select: { name: true } } },
    orderBy: { id: 'asc' },
  })

  // FIX #1: Use $transaction — run creation/update + items + audit in same transaction
  const result = await basePrisma.$transaction(async (tx) => {
    // Create new run or use existing (DRAFT re-calc)
    if (!run) {
      run = await tx.payrollRun.create({
        data: { clinicId, periodMonth: monthDate, status: 'DRAFT' as RunStatus },
      })
    }

    // TODO: strict types
    const items: Array<any> = []
    for (const emp of employees) {
      try {
        // Read employee pay rule to determine engine
        const payRule = await tx.payRule.findFirst({
          where: {
            employeeId: emp.id,
            isActive: true,
          },
          orderBy: { effectiveFrom: 'desc' },
        })

        let calcResult
        if (payRule?.configJson) {
          const config = JSON.parse(payRule.configJson)
          if (config.base_type || config.modifiers) {
            // New modular format → use new engine
            calcResult = await calculatePayrollWithRules(emp.id, monthDate, clinicId, config)
          } else {
            // Legacy format → use old engine (backward compat)
            calcResult = await calculateEmployeePayroll(emp.id, monthDate, clinicId)
          }
        } else {
          // No rule → use old engine
          calcResult = await calculateEmployeePayroll(emp.id, monthDate, clinicId)
        }

        items.push({
          runId: run.id,
          employeeId: emp.id,
          workedHours: calcResult.workedHours,
          otHours: calcResult.otHours,
          leaveDays: calcResult.leaveDays,
          absentDays: calcResult.absentDays,
          basePay: calcResult.basePay,
          otPay: calcResult.otPay,
          splitPay: calcResult.splitPay,
          deduction: calcResult.deduction,
          totalPayable: calcResult.totalPayable,
          detailJson: JSON.stringify(calcResult.detail),
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
      await tx.payrollItem.createMany({ data: items })
    }

    // Manual audit inside same transaction
    if (auditCtx?.actorId) {
      await tx.auditLog.create({
        data: {
          actorId: auditCtx.actorId,
          action: 'CREATE_PAYROLL_RUN',
          entity: 'PayrollRun',
          entityId: run.id,
          notes: `Generated payroll for ${periodMonth}: ${items.length} employees${isRecalculation ? ' (recalculation)' : ''}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })
    }

    const totalPayable = items.reduce((sum, item) => sum + item.totalPayable, 0)

    return { runId: run.id, itemCount: items.length, totalPayable: Math.round(totalPayable * 100) / 100 }
  })

  return result
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

// ============================================================
// Part B — Composable Rule Engine (modular base + modifier)
// New entry: calculatePayrollWithRules()
// Old calculateEmployeePayroll() preserved for backward compat
// ============================================================

// ------------------------------------------------------------------
// Extended PayRuleConfig with modifiers
// ------------------------------------------------------------------

/**
 * Work data collected from punch/leave/shift records for a given month
 */
interface WorkData {
  dailyEntries: DailyHoursEntry[]
  totalWorkedHours: number
  actualAttendanceDays: number
  approvedLeaveDays: number
  paidLeaveDays: number
  publicHolidayDays: number
  workingDays: number
  lateRecords: Array<{ date: string; minutes: number }>
  leaveRecords: Array<{ isPlanned: boolean; days: number }>
  partialDays: string[]
  consultationFees: number
}

/**
 * Payroll result from the modular engine
 */
interface PayrollResult {
  basePay: number
  otPay: number
  splitPay: number | null
  attendanceBonus: number
  attendanceBonusCancelled: boolean
  attendanceBonusReason?: string
  deduction: number
  totalPayable: number
  absentDays: number
  otHours: number
  workedHours: number
  leaveDays: number
  error?: string
  detail: Record<string, unknown>
}

/**
 * Composable rule config (stored as JSON in PayRule.configJson)
 */
export interface PayRuleConfigModular {
  // Base module (mutually exclusive, pick one)
  base_type?: 'monthly' | 'hourly' | 'daily' | 'split'

  // Base parameters
  monthly_salary?: number
  hourly_rate?: number
  daily_rate?: number
  split_ratio?: number
  base_guarantee?: number
  deduction_rate?: number
  ot_multiplier?: number
  ot_threshold?: number
  ot_threshold_daily?: number

  // Modifier modules (composable, any combination)
  modifiers?: {
    attendance_bonus?: {
      amount: number
      cancel_if: {
        late_minutes_exceed?: number
        late_is_cumulative?: boolean
        any_unplanned_leave?: boolean
      }
    }
    overtime?: {
      mode: 'pay' | 'time_off'
      multiplier?: number
      threshold?: number
    }
    late_policy?: {
      deduct_salary?: boolean
      affects_bonus?: boolean
      offset_from_time_bank?: boolean
    }
    time_bank?: {
      negative_carry: 'next_month' | 'deduct_salary' | 'deduct_bonus' | 'reset'
    }
    working_days?: {
      rest_days?: number[]
      count_public_holidays?: boolean
    }
    allowances?: Array<{
      name: string
      amount: number
      type: 'fixed' | 'conditional'
    }>
  }

  // Legacy fields (backwards compat)
  consultation_target?: number
}

// ------------------------------------------------------------------
// 2a. Attendance Bonus Evaluation
// ------------------------------------------------------------------

/**
 * Evaluate attendance bonus based on config and work data.
 * @returns { amount, cancelled, reason? }
 */
export function evaluateAttendanceBonus(
  config: {
    amount: number
    cancel_if?: {
      late_minutes_exceed?: number
      late_is_cumulative?: boolean
      any_unplanned_leave?: boolean
    }
  },
  workData: {
    lateRecords: Array<{ minutes: number }>
    leaveRecords: Array<{ isPlanned: boolean }>
  }
): { amount: number; cancelled: boolean; reason?: string } {
  const cancelIf = config.cancel_if || {}
  const bonusAmount = config.amount || 0

  // Late check
  if (cancelIf.late_minutes_exceed !== undefined) {
    let lateTotal = 0
    if (cancelIf.late_is_cumulative === true) {
      lateTotal = workData.lateRecords.reduce((sum, r) => sum + r.minutes, 0)
    } else {
      lateTotal = workData.lateRecords.reduce((max, r) => Math.max(max, r.minutes), 0)
    }
    if (lateTotal > cancelIf.late_minutes_exceed) {
      return { amount: 0, cancelled: true, reason: `遲到${lateTotal}分鐘超過${cancelIf.late_minutes_exceed}分鐘門檻` }
    }
  }

  // Unplanned leave check
  if (cancelIf.any_unplanned_leave === true) {
    const hasUnplanned = workData.leaveRecords.some(r => r.isPlanned === false)
    if (hasUnplanned) {
      return { amount: 0, cancelled: true, reason: '有臨時請假' }
    }
  }

  return { amount: bonusAmount, cancelled: false }
}

// ------------------------------------------------------------------
// 2b. Time Bank Calculation
// ------------------------------------------------------------------

/**
 * Calculate monthly time bank for an employee.
 */
export async function calculateTimeBank(
  employeeId: string,
  monthDate: Date,
  config: { negative_carry?: string },
  db: any
): Promise<{
  otMinutes: number
  lateMinutes: number
  carriedFrom: number
  balance: number
  note: string
}> {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()
  const monthStart = new Date(year, month, 1)
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59)

  // Previous month carry
  const lastMonth = month === 0 ? new Date(year - 1, 11, 1) : new Date(year, month - 1, 1)
  const lastMonthRecord = await db.timeBank.findFirst({
    where: {
      employeeId,
      periodMonth: {
        gte: lastMonth,
        lte: new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0, 23, 59, 59),
      },
    },
  })
  const carriedFrom = lastMonthRecord?.balance ?? 0

  // OT minutes — placeholder, to be connected with OT calculation logic
  // TODO: integrate with OT calculation
  const otMinutes = 0

  // Late minutes from punch records vs shift start times
  const punches = await db.punchRecord.findMany({
    where: {
      employeeId,
      punchTime: { gte: monthStart, lte: monthEnd },
      punchType: 'CLOCK_IN',
    },
    orderBy: { punchTime: 'asc' },
  })

  const shifts = await db.shift.findMany({
    where: {
      employeeId,
      date: { gte: monthStart, lte: monthEnd },
      status: { not: 'CANCELLED' },
    },
    orderBy: { date: 'asc' },
  })

  let lateMinutes = 0
  for (const shift of shifts) {
    const dayStart = new Date(shift.date)
    const dayEnd = new Date(dayStart)
    dayEnd.setHours(23, 59, 59)

    const dayPunches = punches.filter(
      (p: any) => p.punchTime >= dayStart && p.punchTime <= dayEnd
    )
    if (dayPunches.length > 0) {
      const firstPunch = dayPunches[0]
      // shift.startTime is a DateTime — compare directly
      let shiftStartTime: Date
      if (shift.startTime instanceof Date) {
        shiftStartTime = shift.startTime
      } else {
        // Fallback: parse as string
        shiftStartTime = new Date(shift.startTime)
      }
      if (firstPunch.punchTime > shiftStartTime) {
        lateMinutes += Math.ceil((firstPunch.punchTime.getTime() - shiftStartTime.getTime()) / 60000)
      }
    }
  }

  const balance = carriedFrom + otMinutes - lateMinutes

  // End-of-month strategy
  let note = ''
  if (balance < 0 && config.negative_carry) {
    switch (config.negative_carry) {
      case 'next_month':
        note = `負結餘${balance}分鐘欠到下月`
        break
      case 'deduct_salary':
        note = `負結餘${balance}分鐘從薪資扣除`
        break
      case 'deduct_bonus':
        note = `負結餘${balance}分鐘扣勤工獎`
        break
      case 'reset':
        note = `負結餘${balance}分鐘已清零`
        break
    }
  }

  return { otMinutes, lateMinutes, carriedFrom, balance, note }
}

// ------------------------------------------------------------------
// 2c. Working Days with Custom Rest Days + Public Holidays
// ------------------------------------------------------------------

/**
 * Check if a date is a HK public holiday (built-in 2026 data).
 * TODO: Replace with external data source (e.g., HKPublicHoliday table or API)
 */
function isPublicHoliday(date: Date): boolean {
  const ymd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

  // 2026 HK statutory public holidays
  const HK_PUBLIC_HOLIDAYS_2026 = new Set([
    '2026-01-01', // 元旦
    '2026-02-17', // 農曆新年（除夕可能變動）
    '2026-02-18',
    '2026-02-19',
    '2026-02-20',
    '2026-04-01', // 清明
    '2026-04-06', // 耶穌受難節
    '2026-04-08', // 耶穌受難節（星期日）
    '2026-04-09', // 復活節星期一
    '2026-04-30', // 國慶
    '2026-05-01', // 勞動節
    '2026-06-19', // 端午
    '2026-07-01', // 香港特別行政區成立紀念日
    '2026-09-25', // 中秋節翌日
    '2026-10-01', // 國慶（若與7/1重疊則另一日）
    '2026-10-22', // 重陽節
    '2026-12-25', // 聖誕節
    '2026-12-26', // 聖誕節翌日
  ])
  return HK_PUBLIC_HOLIDAYS_2026.has(ymd)
}

/**
 * Count working days in a month with custom rest_days + public holidays.
 */
export function countWorkingDaysInMonth(
  year: number,
  month: number, // 0-indexed
  config: {
    rest_days?: number[]
    count_public_holidays?: boolean
  }
): { totalDays: number; restDays: number; publicHolidays: number; workingDays: number } {
  const { rest_days = [6, 0], count_public_holidays = false } = config
  const totalDaysInMonth = new Date(year, month + 1, 0).getDate()

  let restDays = 0
  let publicHolidays = 0

  for (let d = 1; d <= totalDaysInMonth; d++) {
    const date = new Date(year, month, d)
    const dow = date.getDay()
    if (rest_days.includes(dow)) {
      restDays++
    }
    if (count_public_holidays && isPublicHoliday(date)) {
      publicHolidays++
    }
  }

  const workingDays = totalDaysInMonth - restDays - publicHolidays
  return { totalDays: totalDaysInMonth, restDays, publicHolidays, workingDays }
}

// ------------------------------------------------------------------
// 3. Modular Engine: Work Data Collection
// ------------------------------------------------------------------

/**
 * Collect all work data needed for the modular payroll calculation.
 */
async function collectWorkData(
  employeeId: string,
  monthDate: Date,
  clinicId: string | null
): Promise<WorkData> {
  const { start: monthStart, end: monthEnd } = getMonthRange(monthDate)
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()

  // Get employee clinic IDs
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: { clinics: { select: { clinicId: true } } },
  })
  const clinicIds = employee
    ? employee.clinics.map((ec: any) => ec.clinicId).filter((id: string) => !clinicId || id === clinicId)
    : []

  // Punch days
  const allPunchDays = await calculateWorkedHours(
    employeeId,
    clinicId ? [clinicId] : (clinicIds.length > 0 ? clinicIds : null),
    monthStart,
    monthEnd
  )

  const dailyEntries = aggregateDailyHours(allPunchDays)

  let totalWorkedHours = 0
  const attendanceDaysSet = new Set<string>()
  const partialDays: string[] = []

  for (const pd of allPunchDays) {
    totalWorkedHours += pd.hours
    if (pd.hours > 0) attendanceDaysSet.add(pd.date)
    if (pd.isPartial) partialDays.push(pd.date)
  }

  const { totalDays: approvedLeaveDays, byType: leaveByType } =
    await getApprovedLeaveDays(employeeId, monthStart, monthEnd)
  const paidLeaveDays = leaveByType.reduce((sum, lt) => sum + (lt.isPaid ? lt.days : 0), 0)

  // Leave records with isPlanned flag
  const leaveRecords = await prisma.leaveRequest.findMany({
    where: {
      employeeId,
      status: 'APPROVED',
      startDate: { lte: monthEnd },
      endDate: { gte: monthStart },
    },
  })
  const leaveRecordsForEngine = leaveRecords.map((lr: any) => ({
    isPlanned: lr.isPlanned !== false, // default true if null (legacy)
    days: lr.days,
  }))

  const publicHolidays = await getPublicHolidayDays(monthStart, monthEnd)
  const publicHolidayDays = publicHolidays.length
  const workingDays = countWorkingDays(year, month)

  // Late records: compare clock-in times with shift start times
  const punches = await prisma.punchRecord.findMany({
    where: {
      employeeId,
      punchTime: { gte: monthStart, lte: monthEnd },
      punchType: 'CLOCK_IN',
    },
    orderBy: { punchTime: 'asc' },
  })

  const shifts = await prisma.shift.findMany({
    where: {
      employeeId,
      date: { gte: monthStart, lte: monthEnd },
      status: { not: 'CANCELLED' },
    },
    orderBy: { date: 'asc' },
  })

  const lateRecords: Array<{ date: string; minutes: number }> = []
  for (const shift of shifts) {
    const dayStart = new Date(shift.date)
    const dayEnd = new Date(dayStart)
    dayEnd.setHours(23, 59, 59)

    const dayPunches = punches.filter(
      (p: any) => p.punchTime >= dayStart && p.punchTime <= dayEnd
    )
    if (dayPunches.length > 0) {
      const firstPunch = dayPunches[0]
      let shiftStartTime: Date
      if (shift.startTime instanceof Date) {
        shiftStartTime = shift.startTime
      } else {
        shiftStartTime = new Date(shift.startTime)
      }
      if (firstPunch.punchTime > shiftStartTime) {
        const minutes = Math.ceil((firstPunch.punchTime.getTime() - shiftStartTime.getTime()) / 60000)
        lateRecords.push({ date: formatDate(firstPunch.punchTime), minutes })
      }
    }
  }

  // Consultation fees (for split pay)
  const consultationFees = await getConsultationRevenue(employeeId, clinicId, monthDate)

  return {
    dailyEntries,
    totalWorkedHours,
    actualAttendanceDays: attendanceDaysSet.size,
    approvedLeaveDays,
    paidLeaveDays,
    publicHolidayDays,
    workingDays,
    lateRecords,
    leaveRecords: leaveRecordsForEngine,
    partialDays,
    consultationFees,
  }
}

// ------------------------------------------------------------------
// 3. Base Module Calculators
// ------------------------------------------------------------------

function calcMonthlyBase(config: PayRuleConfigModular, workData: WorkData): PayrollResult {
  const monthlySalary = config.monthly_salary || 0
  const deductionRate = config.deduction_rate ?? 1
  const otMultiplier = config.ot_multiplier ?? 1.5
  const otThreshold = config.ot_threshold ?? 0

  const unpaidLeaveDays = workData.approvedLeaveDays - workData.paidLeaveDays
  const absentDays = Math.max(
    0,
    workData.workingDays - workData.actualAttendanceDays - unpaidLeaveDays - workData.publicHolidayDays
  )

  const basePay = monthlySalary
  const deduction = absentDays * (monthlySalary / 26) * deductionRate

  const otHours = otThreshold > 0 ? Math.max(0, workData.totalWorkedHours - otThreshold) : 0
  const hourlyEquivalent = otThreshold > 0 ? monthlySalary / otThreshold : 0
  const otPay = otHours * hourlyEquivalent * otMultiplier

  return {
    basePay,
    otPay,
    splitPay: null,
    attendanceBonus: 0,
    attendanceBonusCancelled: false,
    deduction,
    totalPayable: basePay - deduction + otPay,
    absentDays,
    otHours,
    workedHours: workData.totalWorkedHours,
    leaveDays: workData.approvedLeaveDays,
    detail: {
      baseType: 'monthly',
      monthlySalary,
      workingDays: workData.workingDays,
      actualAttendanceDays: workData.actualAttendanceDays,
      approvedLeaveDays: workData.approvedLeaveDays,
      paidLeaveDays: workData.paidLeaveDays,
      unpaidLeaveDays,
      publicHolidayDays: workData.publicHolidayDays,
      absentDays,
      deductionRate,
      otThreshold,
      otHours,
      hourlyEquivalent,
      otMultiplier,
    },
  }
}

function calcHourlyBase(config: PayRuleConfigModular, workData: WorkData): PayrollResult {
  const hourlyRate = config.hourly_rate || 0
  const otMultiplier = config.ot_multiplier ?? 1.5
  const otThresholdDaily = config.ot_threshold_daily ?? 0

  let totalNormalHours = 0
  let totalOtHours = 0

  for (const entry of workData.dailyEntries) {
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
    splitPay: null,
    attendanceBonus: 0,
    attendanceBonusCancelled: false,
    deduction: 0,
    totalPayable: basePay + otPay,
    absentDays: 0,
    otHours: totalOtHours,
    workedHours: totalNormalHours + totalOtHours,
    leaveDays: workData.approvedLeaveDays,
    detail: {
      baseType: 'hourly',
      hourlyRate,
      totalNormalHours,
      otHours: totalOtHours,
      otThresholdDaily,
      otMultiplier,
    },
  }
}

function calcDailyBase(config: PayRuleConfigModular, workData: WorkData): PayrollResult {
  const dailyRate = config.daily_rate || 0
  const otMultiplier = config.ot_multiplier ?? 1.5
  const otThresholdDaily = config.ot_threshold_daily ?? 0

  const basePay = workData.actualAttendanceDays * dailyRate

  let totalOtHours = 0
  let totalHours = 0
  for (const entry of workData.dailyEntries) {
    totalHours += entry.totalHours
    const ot = Math.max(0, entry.totalHours - otThresholdDaily)
    totalOtHours += ot
  }

  const hourlyEquivalent = otThresholdDaily > 0 ? dailyRate / otThresholdDaily : 0
  const otPay = totalOtHours * hourlyEquivalent * otMultiplier

  return {
    basePay,
    otPay,
    splitPay: null,
    attendanceBonus: 0,
    attendanceBonusCancelled: false,
    deduction: 0,
    totalPayable: basePay + otPay,
    absentDays: 0,
    otHours: totalOtHours,
    workedHours: totalHours,
    leaveDays: workData.approvedLeaveDays,
    detail: {
      baseType: 'daily',
      dailyRate,
      attendanceDays: workData.actualAttendanceDays,
      totalHours,
      otHours: totalOtHours,
      otThresholdDaily,
      otMultiplier,
    },
  }
}

function calcSplitBase(config: PayRuleConfigModular, workData: WorkData): PayrollResult {
  const splitRatio = config.split_ratio ?? 0
  const basePay = config.monthly_salary ?? 0
  const consultationFees = workData.consultationFees
  const splitPay = consultationFees * splitRatio
  const deductionRate = config.deduction_rate ?? 1

  let deduction = 0
  if (basePay > 0) {
    const unpaidLeaveDays = workData.approvedLeaveDays - workData.paidLeaveDays
    const absentDays = Math.max(
      0,
      workData.workingDays - workData.actualAttendanceDays - unpaidLeaveDays - workData.publicHolidayDays
    )
    deduction = absentDays * (basePay / 26) * deductionRate
  }

  return {
    basePay,
    otPay: 0,
    splitPay,
    attendanceBonus: 0,
    attendanceBonusCancelled: false,
    deduction,
    totalPayable: basePay - deduction + splitPay,
    absentDays: 0,
    otHours: 0,
    workedHours: workData.totalWorkedHours,
    leaveDays: workData.approvedLeaveDays,
    detail: {
      baseType: 'split',
      splitRatio,
      consultationFees,
      splitPay,
    },
  }
}

/**
 * Run the selected base module (monthly/hourly/daily/split).
 */
export function runBaseModule(config: PayRuleConfigModular, workData: WorkData): PayrollResult {
  const baseType = config.base_type || 'monthly'
  switch (baseType) {
    case 'monthly': return calcMonthlyBase(config, workData)
    case 'hourly': return calcHourlyBase(config, workData)
    case 'daily': return calcDailyBase(config, workData)
    case 'split': return calcSplitBase(config, workData)
    default:
      return {
        basePay: 0, otPay: 0, splitPay: null, attendanceBonus: 0,
        attendanceBonusCancelled: false, deduction: 0, totalPayable: 0,
        absentDays: 0, otHours: 0, workedHours: 0, leaveDays: 0,
        detail: {},
        error: `Unknown base_type: ${baseType}`,
      }
  }
}

// ------------------------------------------------------------------
// 3. Modifier Application
// ------------------------------------------------------------------

function applyAttendanceBonusModifier(
  modConfig: { amount: number; cancel_if: { late_minutes_exceed?: number; late_is_cumulative?: boolean; any_unplanned_leave?: boolean } },
  result: PayrollResult,
  workData: WorkData
): PayrollResult {
  const bonus = evaluateAttendanceBonus(modConfig, {
    lateRecords: workData.lateRecords.map(r => ({ minutes: r.minutes })),
    leaveRecords: workData.leaveRecords,
  })

  const next = { ...result }
  next.attendanceBonus = bonus.amount
  next.attendanceBonusCancelled = bonus.cancelled
  next.attendanceBonusReason = bonus.reason
  next.totalPayable = result.basePay - result.deduction + result.otPay + (result.splitPay || 0) + bonus.amount
  next.detail = { ...result.detail, attendanceBonus: bonus }
  return next
}

function applyOvertimeModifier(
  modConfig: { mode: 'pay' | 'time_off'; multiplier?: number; threshold?: number },
  result: PayrollResult,
  _workData: WorkData
): PayrollResult {
  const next = { ...result }
  if (modConfig.mode === 'time_off') {
    // OT converted to time off — no monetary OT pay
    next.otPay = 0
    next.totalPayable = result.basePay - result.deduction + (result.splitPay || 0) + result.attendanceBonus
    next.detail = { ...result.detail, otMode: 'time_off', otHoursOff: result.otHours }
  }
  return next
}

function applyAllowancesModifier(
  allowances: Array<{ name: string; amount: number; type: 'fixed' | 'conditional' }>,
  result: PayrollResult
): PayrollResult {
  const totalAllowances = allowances.reduce((sum, a) => {
    if (a.type === 'fixed') return sum + a.amount
    // Conditional allowances — for now treat as fixed, add condition check later
    return sum + a.amount
  }, 0)

  const next = { ...result }
  next.totalPayable = result.totalPayable + totalAllowances
  next.detail = { ...result.detail, allowances, totalAllowances }
  return next
}

// ------------------------------------------------------------------
// 3. Main Modular Entry: calculatePayrollWithRules
// ------------------------------------------------------------------

/**
 * Main entry for the modular rule engine.
 * Uses base_type + modifiers pattern from PayRuleConfigModular.
 */
export async function calculatePayrollWithRules(
  employeeId: string,
  monthDate: Date,
  clinicId: string | null,
  config: PayRuleConfigModular
): Promise<PayrollResult> {
  // 1. Collect work data
  const workData = await collectWorkData(employeeId, monthDate, clinicId)

  // 2. Run base module
  const baseResult = runBaseModule(config, workData)

  // 3. Apply modifiers in order
  let result: PayrollResult = baseResult
  const mods = config.modifiers || {}

  if (mods.attendance_bonus) {
    result = applyAttendanceBonusModifier(mods.attendance_bonus, result, workData)
  }
  if (mods.overtime) {
    result = applyOvertimeModifier(mods.overtime, result, workData)
  }
  if (mods.allowances && mods.allowances.length > 0) {
    result = applyAllowancesModifier(mods.allowances, result)
  }

  // Round final values
  return {
    ...result,
    basePay: Math.round(result.basePay * 100) / 100,
    otPay: Math.round(result.otPay * 100) / 100,
    splitPay: result.splitPay != null ? Math.round(result.splitPay * 100) / 100 : null,
    attendanceBonus: Math.round(result.attendanceBonus * 100) / 100,
    deduction: Math.round(result.deduction * 100) / 100,
    totalPayable: Math.round(result.totalPayable * 100) / 100,
    workedHours: Math.round(result.workedHours * 100) / 100,
    otHours: Math.round(result.otHours * 100) / 100,
    leaveDays: Math.round(result.leaveDays * 100) / 100,
    absentDays: Math.round(result.absentDays * 100) / 100,
  }
}
