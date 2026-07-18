// ============================================================
// Payroll Engine — Phase 6 (Audit-Fixed) + Full Payroll Rules
// Parametric salary calculation from PayRule.configJson
// Sources: PunchRecord (corrected), LeaveRequest, Shift, HKPublicHoliday
// Fixes: paired hours, cross-clinic OT, clinicId corrections,
//        single-punch pending, parametric OT thresholds,
//        consultation revenue lookup
// ============================================================

import { prisma, basePrisma } from './prisma'
import { getEffectivePunches } from './punch-query'
import { toHKDateStr, getMonthRange, hkDaysInMonth, hkDayOfWeek, hkDateStart, hkDateEnd, addDays, hkParts } from './hk-date'
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

function countWorkingDays(year: number, month: number): number {
  let count = 0
  // UTC-safe: build monthDate to get daysInMonth; use getUTCDay for weekday
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const dayOfWeek = new Date(Date.UTC(year, month, d)).getUTCDay()
    if (dayOfWeek !== 0 && dayOfWeek !== 6) count++
  }
  return count
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

/**
 * HK Statutory Daily Wage = monthlySalary × 12 ÷ 365
 * Per HK Employment Ordinance
 */
function statutoryDailyWage(monthlySalary: number): number {
  return (monthlySalary * 12) / 365
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
  monthEnd: Date,
  shifts?: Array<{ date: Date | string; clinicId?: string; startTime?: Date | string; endTime?: Date | string }>
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
      where: {
        ...where,
        void: { is: null }, // Exclude voided punches
      },
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

    // FIX #14 + T1: Single punch + shift → use shift endTime to fill hours
    const hasIn = entry.punchIns.length > 0
    const hasOut = entry.punchOuts.length > 0
    const isPartial = (hasIn && !hasOut) || (!hasIn && hasOut)

    // If single CLOCK_IN with no CLOCK_OUT and shift data available, use shift endTime
    if (hasIn && !hasOut && lastIn && shifts && shifts.length > 0) {
      const shiftForDay = shifts.find(s => toHKDateStr(new Date(s.date)) === dayStr)
      if (shiftForDay && shiftForDay.endTime) {
        const endTime = new Date(shiftForDay.endTime)
        totalMs = endTime.getTime() - lastIn.getTime()
        lastIn = null
      }
    }

    const hours = Math.min(Math.max(0, totalMs / 3600000), 24)

    // FIX #14: Single punch → PENDING, not absent

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

    // TZ-safe date iteration via string arithmetic
    let current = toHKDateStr(effectiveStart)
    const endStr = toHKDateStr(effectiveEnd)
    let overlapDays = 0
    while (current <= endStr) {
      overlapDays++
      current = addDays(current, 1)
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
// Sick Deduction — Tiered (continuous 4-day threshold, EO 4/5 pay)
// ------------------------------------------------------------------

/**
 * 病假分層扣減（連續 4 天門檻，EO 4/5 工資）
 * episode = 已批病假覆蓋的相鄰公曆日合併（跨假單）；≥4 天 → 1/5×日薪，<4 天 → 1×日薪
 * 回傳本月扣減額 + 明細（跨月：只扣落在本月的日子，檔位看整段）
 */
export async function computeSickDeduction(
  employeeId: string,
  monthStart: Date,
  monthEnd: Date,
  monthlySalary: number,
  deductionRate: number,
  db: any,
): Promise<{
  amount: number;
  episodes: Array<{ range: string; totalDays: number; daysInMonth: number; rate: number }>;
}> {
  // 窗口跨出本月 ±40 天：跨月連續段兩頭都要看得到
  const winStart = new Date(monthStart.getTime() - 40 * 86400000)
  const winEnd = new Date(monthEnd.getTime() + 40 * 86400000)

  const sickLeaves = await db.leaveRequest.findMany({
    where: {
      employeeId,
      status: 'APPROVED',
      leaveType: { systemKey: 'SICK' },
      startDate: { lte: winEnd },
      endDate: { gte: winStart },
    },
    orderBy: { startDate: 'asc' },
  })
  if (sickLeaves.length === 0) return { amount: 0, episodes: [] }

  // 展開成 HK 日字串集合（鐵律：跨表/跨界比對先轉 HK 日）
  const dayset = new Set<string>()
  for (const lr of sickLeaves) {
    let d = toHKDateStr(lr.startDate)
    const end = toHKDateStr(lr.endDate)
    while (d <= end) { dayset.add(d); d = addDays(d, 1) }
  }

  // 合併連續段
  const sorted = [...dayset].sort()
  const episodes: string[][] = []
  let cur: string[] = []
  for (const d of sorted) {
    if (cur.length === 0 || d === addDays(cur[cur.length - 1], 1)) cur.push(d)
    else { episodes.push(cur); cur = [d] }
  }
  if (cur.length) episodes.push(cur)

  // 逐段結算（只扣落在本月的日子；檔位看整段）
  const dailyRate = statutoryDailyWage(monthlySalary)
  const mStart = toHKDateStr(monthStart), mEnd = toHKDateStr(monthEnd)
  let amount = 0
  const detail: Array<{ range: string; totalDays: number; daysInMonth: number; rate: number }> = []
  for (const ep of episodes) {
    const daysInMonth = ep.filter(d => d >= mStart && d <= mEnd).length
    if (daysInMonth === 0) continue
    const rate = ep.length >= 4 ? 0.2 : 1  // ≥4 連續：扣 1/5（支付 4/5）；<4：全扣
    amount += daysInMonth * dailyRate * rate * deductionRate
    detail.push({ range: `${ep[0]}~${ep[ep.length - 1]}`, totalDays: ep.length, daysInMonth, rate })
  }
  return { amount: Math.round(amount * 100) / 100, episodes: detail }
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
  return holidays.map(h => new Date(h.date))
}

// ------------------------------------------------------------------
// Employee Pay Data
// ------------------------------------------------------------------

async function getEmployeePayData(
  employeeId: string,
  clinicIdFilter: string | null,
  monthDate?: Date  // optional: 計糧月份，用於選 payRules 時做月份對齊
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
          ...(monthDate ? (() => {
            const { start: ms, end: me } = getMonthRange(monthDate)
            return {
              effectiveFrom: { lte: me },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: ms } }],
            }
          })() : {
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
          }),
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
  // isPartial days already included in actualAttendanceDays (attendanceDaysSet.add on isPartial)
  const absentDays = Math.max(
    0,
    workingDays - actualAttendanceDays - approvedLeaveDays - publicHolidayDays
  )

  // ✅ 修正：基本薪資根據實際出勤日數 / 工作天數比例計算
  // 有出勤的天數 = actualAttendanceDays + paidLeaveDays（有薪假期也算出勤）
  const paidDays = actualAttendanceDays + paidLeaveDays + publicHolidayDays
  const basePay = workingDays > 0 ? (paidDays / workingDays) * monthlySalary : 0
  // HK Statutory: dailyRate = monthlySalary × 12 ÷ 365
  const dailyRate = statutoryDailyWage(monthlySalary)
  const deduction = absentDays * dailyRate * deductionRate

  // FIX #7: OT threshold from config, no default
  const otHours = Math.max(0, totalHours - otThreshold)
  const hourlyEquivalent = otThreshold > 0 ? monthlySalary / otThreshold : 0
  const otPay = otHours * hourlyEquivalent * otMultiplier

  return {
    basePay: Math.round(basePay * 100) / 100,
    otPay: Math.round(otPay * 100) / 100,
    deduction: Math.round(deduction * 100) / 100,
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
// Full Payroll Run
// ------------------------------------------------------------------

export async function generatePayrollRun(
  clinicId: string | null,
  periodMonth: string,
  auditCtx?: AuditCtx,
  storeBonuses?: Record<string, number> // { employeeId: amount }
): Promise<
  | { runId: string; itemCount: number; totalPayable: number }
  | { error: string; runId: string; status: string }
> {
  // Parse YYYY-MM → HK-tz-safe Date (use +08:00 suffix to avoid local TZ confusion)
  const [yearStr, monthStr] = periodMonth.split('-')
  const monthDate = new Date(`${periodMonth}-01T00:00:00+08:00`)

  const { start: monthStart, end: monthEnd } = getMonthRange(monthDate)
  const { y: year, m: month } = hkParts(monthDate)

  const existing = await prisma.payrollRun.findFirst({
    where: {
      clinicId: clinicId ?? null,
      periodMonth: { gte: monthStart, lte: monthEnd },
    },
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

  // FIX: Use homeClinicId instead of EmployeeClinic to avoid multi-clinic duplicates
  // Employees with assigned clinic but no homeClinicId get a transition warning
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
  if (clinicId) where.homeClinicId = clinicId

  const employees = await prisma.employee.findMany({
    where,
    include: { user: { select: { name: true } } },
    orderBy: { id: 'asc' },
  })

  // 3d: Transition warning — detect employees assigned to this clinic but homeClinicId=null
  let transitionWarning: string | null = null
  if (clinicId) {
    const unassignedEmps = await prisma.employee.findMany({
      where: {
        status: 'ACTIVE',
        homeClinicId: null,
        clinics: { some: { clinicId } },
      },
      include: { user: { select: { name: true } } },
      take: 10,
    })
    if (unassignedEmps.length > 0) {
      const names = unassignedEmps.map(e => e.user.name).join('、')
      transitionWarning = `以下員工已指派本店但未設定長駐店鋪，將不出現在計糧中：${names}${unassignedEmps.length > 10 ? ' …等' : ''}`
    }
  }

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
    const skipped: Array<{ employeeId: string; name: string; reason: string }> = []
    for (const emp of employees) {
      try {
        // Read employee pay rule to determine engine
        // 🔧 Fix: 按計糧月份選規則，時區安全
        const { start: monthStartForRule, end: monthEndForRule } = getMonthRange(monthDate)
        const payRule = await tx.payRule.findFirst({
          where: {
            employeeId: emp.id,
            isActive: true,
            effectiveFrom: { lte: monthEndForRule },
            OR: [
              { effectiveTo: null },
              { effectiveTo: { gte: monthStartForRule } },
            ],
          },
          orderBy: { effectiveFrom: 'desc' },
        })

        let calcResult
        if (payRule?.configJson) {
          const config = JSON.parse(payRule.configJson)
          // Safety check: if still old format, error instead of silently using old engine
          if (!config.base_type && !config.modifiers) {
            console.error(`Employee ${emp.id} still has old-format payRule! Run migrate-payrules.`)
            skipped.push({ employeeId: emp.id, name: emp.user.name, reason: '薪酬規則格式過舊，請重新設定' })
            continue
          }
          calcResult = await calculatePayrollWithRules(emp.id, monthDate, clinicId, config, {
            ...(config.base_type !== 'hourly' && storeBonuses?.[emp.id] ? { storeBonus: storeBonuses[emp.id] } : {}),
          })

          // 🆕 Grant next month rest day pool (idempotent — safe on recalc)
          const nextMonth = new Date(year, month + 1, 1) // year/month from hkParts → 0-indexed month+1
          await grantRestDaysForMonth(emp.id, nextMonth, tx)
        } else {
          // No rule at all → skip with warning
          console.warn(`Employee ${emp.id} has no payRule, skipping`)
          skipped.push({ employeeId: emp.id, name: emp.user.name, reason: '未設定薪酬規則' })
          continue
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
          storeBonus: (calcResult.detail as any)?.storeBonus ?? 0,
          totalPayable: calcResult.totalPayable,
          detailJson: JSON.stringify(calcResult.detail),
        })
      } catch (err) {
        console.error(`Failed payroll for ${emp.id}:`, err)
        items.push({
          runId: run.id,
          employeeId: emp.id,
          workedHours: 0, otHours: 0, leaveDays: 0, absentDays: 0,
          basePay: 0, otPay: 0, splitPay: null, deduction: 0, storeBonus: 0, totalPayable: 0,
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

    return { runId: run.id, itemCount: items.length, totalPayable: Math.round(totalPayable * 100) / 100, skipped, transitionWarning }
  })

  return result
}

// Export for testing
export {
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
  restDays: number
  totalDaysInMonth: number
  monthlyWorkingDays: number
  lateRecords: Array<{ date: string; minutes: number }>
  earlyLeaveRecords: Array<{ date: string; minutes: number }>
  leaveRecords: Array<{ isPlanned: boolean; days: number; cancelsBonus: boolean; name: string }>
  partialDays: string[]
  consultationFees: number
  scheduledDays: number
  absentDays: number
  otDeductedAbsences: Array<{ date: string; minutes: number }>
  shifts: any[]
  makeupEntries: Array<{ date: string; minutes: number; note: string }>
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
  monthly_pay_multiplier?: number
  ot_multiplier?: number
  ot_threshold?: number
  ot_threshold_daily?: number

  // Absence calculation basis: 'monthly' = full month working days, 'scheduled' = only scheduled shift days
  absence_basis?: 'monthly' | 'scheduled'

  // Modifier modules (composable, any combination)
  modifiers?: {
    attendance_bonus?: {
      amount: number
      cancel_if: {
        late_minutes_exceed?: number
        late_is_cumulative?: boolean
        any_unplanned_leave?: boolean
        any_absence?: boolean
      }
    }
    overtime?: {
      mode: 'pay' | 'time_off'
      multiplier?: number
      threshold?: number
      hours_per_leave_day?: number  // 預設 8
      ot_min_minutes?: number       // 每日OT最低分鐘（0=不限）
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
    mpf?: {
      enabled?: boolean
      rate?: number
      min?: number
      max?: number
    }
  }

  // Leave banking: 不放的假存起來
  leave_banking?: {
    enabled?: boolean       // 預設 true
    max_days?: number | null  // 預設 null (無上限)
  }

  // MPF (強積金) configuration
  mpf?: {
    enabled?: boolean
    rate?: number          // 預設 0.05
    min?: number           // 預設 7100 (下限)
    max?: number           // 預設 30000 (上限)
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
      any_absence?: boolean
      any_cancels_bonus_leave?: boolean
    }
  },
  workData: {
    lateRecords: Array<{ minutes: number }>
    earlyRecords: Array<{ minutes: number }>
    leaveRecords: Array<{ isPlanned: boolean; cancelsBonus?: boolean; name?: string }>
    absentDays?: number
  }
): { amount: number; cancelled: boolean; reason?: string } {
  const cancelIf = config.cancel_if || {}
  const bonusAmount = config.amount || 0

  // Late + Early check
  if (cancelIf.late_minutes_exceed !== undefined) {
    let lateTotal = 0, earlyTotal = 0
    if (cancelIf.late_is_cumulative === true) {
      lateTotal = workData.lateRecords.reduce((s, r) => s + r.minutes, 0)
      earlyTotal = workData.earlyRecords.reduce((s, r) => s + r.minutes, 0)
    } else {
      lateTotal = workData.lateRecords.reduce((m, r) => Math.max(m, r.minutes), 0)
      earlyTotal = workData.earlyRecords.reduce((m, r) => Math.max(m, r.minutes), 0)
    }
    const total = cancelIf.late_is_cumulative === true ? lateTotal + earlyTotal : Math.max(lateTotal, earlyTotal)
    if (total > cancelIf.late_minutes_exceed) {
      return { amount: 0, cancelled: true, reason: `遲到${lateTotal}+早退${earlyTotal}=${total}分鐘，超過${cancelIf.late_minutes_exceed}分鐘門檻` }
    }
  }

  // Unplanned leave check
  if (cancelIf.any_unplanned_leave === true) {
    const hasUnplanned = workData.leaveRecords.some(r => r.isPlanned === false)
    if (hasUnplanned) {
      return { amount: 0, cancelled: true, reason: '有臨時請假' }
    }
  }

  // cancelsBonus leave check — always active (no config flag needed)
  const hasCancelsBonusLeave = workData.leaveRecords.some(r => (r.cancelsBonus ?? false) === true)
  if (hasCancelsBonusLeave) {
    const cancelType = workData.leaveRecords.find(r => r.cancelsBonus)
    return { amount: 0, cancelled: true, reason: `本月有${cancelType?.name ?? '請假'}，取消勤工` }
  }

  // Any absence check
  if (cancelIf.any_absence && workData.absentDays !== undefined && workData.absentDays > 0) {
    return { amount: 0, cancelled: true, reason: `缺勤 ${workData.absentDays} 天，取消勤工` }
  }

  return { amount: bonusAmount, cancelled: false }
}

// ------------------------------------------------------------------
// 2b. Time Bank Calculation — with recursive chain repair
// ------------------------------------------------------------------

/**
 * Get carried-from balance, recursively backfilling missing months.
 * If last month has no TimeBank record but has punch data, recalculates it on the fly.
 * @param depth - recursion depth (max 24 months)
 */
async function getCarriedFrom(
  employeeId: string,
  monthDate: Date,
  db: any,
  depth = 0
): Promise<number> {
  if (depth > 24) return 0

  // TZ-safe: subtract one month from monthDate using hkParts
  const { y, m } = hkParts(monthDate)
  const lastMonthM = m - 1 < 0 ? 11 : m - 1
  const lastMonthY = m - 1 < 0 ? y - 1 : y
  const lastMonth = new Date(`${String(lastMonthY).padStart(4, '0')}-${String(lastMonthM + 1).padStart(2, '0')}-01T00:00:00+08:00`)
  const { start: lStart, end: lEnd } = getMonthRange(lastMonth)

  // ① Check existing TimeBank record
  const rec = await db.timeBank.findFirst({
    where: { employeeId, periodMonth: { gte: lStart, lte: lEnd } },
  })
  if (rec) return rec.balance ?? 0

  // ② No record: check if last month had any activity (punches OR TimeBankEntry)
  // ★ TimeBankEntry (INIT_ADJUST/REST_TO_ACCOUNT etc.) also counts as activity!
  const hasPunch = await db.punchRecord.findFirst({
    where: {
      employeeId,
      punchTime: { gte: lStart, lte: lEnd },
      void: { is: null },
    },
  })
  const hasTimeBankEntry = hasPunch ? false : await db.timeBankEntry?.findFirst?.({
    where: { employeeId, date: { gte: lStart, lte: lEnd } },
  }).catch(() => null)
  const hasActivity = hasPunch || hasTimeBankEntry
  if (!hasActivity) return 0 // No activity → chain starts here

  // ③ Has activity but no TimeBank → recursively recalculate last month (single source of truth)
  const tb = await calculateTimeBank(employeeId, lastMonth, {}, db, depth + 1)

  // ④ Persist the backfilled record so future lookups are fast
  await db.timeBank.upsert({
    where: {
      employeeId_periodMonth: { employeeId, periodMonth: lStart },
    },
    update: { balance: tb.balance, carriedFrom: tb.carriedFrom },
    create: {
      employeeId,
      periodMonth: lStart,
      balance: tb.balance,
      carriedFrom: tb.carriedFrom,
      otMinutes: tb.otMinutes,
      lateMinutes: tb.lateMinutes,
      makeupMinutes: tb.makeupMinutes,
    },
  })
  return tb.balance
}

/**
 * Calculate monthly time bank for an employee.
 * Computes OT, late, early-leave from shift vs punch records.
 * Makeup entries reduce netLate. Balance = carriedFrom + OT - makeup - netLate + converted.
 */
export async function calculateTimeBank(
  employeeId: string,
  monthDate: Date,
  config: { negative_carry?: string },
  db: any,
  depth = 0
): Promise<{
  otMinutes: number
  lateMinutes: number
  netLateMinutes: number
  netEarlyMinutes: number
  netDeficitMinutes: number
  earlyLeaveMinutes: number
  makeupMinutes: number
  makeupAbsentMinutes: number
  carriedFrom: number
  timeAccountMinutes: number
  balance: number
  owedMinutes: number
  availableMinutes: number
  convertibleLeaveDays: number
  note: string
}> {
  // TZ-safe month range
  const { start: monthStart, end: monthEnd } = getMonthRange(monthDate)

  // Get OT minimum threshold from payRule
  let otMinMinutes = 0
  try {
    const rule = await db.payRule.findFirst({
      where: {
        employeeId,
        isActive: true,
        effectiveFrom: { lte: monthEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    })
    if (rule?.configJson) {
      const cfg = typeof rule.configJson === 'string' ? JSON.parse(rule.configJson) : rule.configJson
      otMinMinutes = cfg?.modifiers?.overtime?.ot_min_minutes ?? 0
    }
  } catch {
    otMinMinutes = 0
  }

  // Previous month carry — recursive backfill (pass depth to prevent infinite recursion)
  const carriedFrom = await getCarriedFrom(employeeId, monthDate, db, depth)

  // Grab ALL effective punches (CLOCK_IN + CLOCK_OUT) with corrections applied
  const effectivePunches = await getEffectivePunches(monthStart, monthEnd, { employeeId, db })

  const shifts = await db.shift.findMany({
    where: {
      employeeId,
      date: { gte: monthStart, lte: monthEnd },
      status: { not: 'CANCELLED' },
    },
    orderBy: { date: 'asc' },
  })

  // Compare each shift day against effective punches
  let otMinutes = 0
  let lateMinutes = 0
  let earlyLeaveMinutes = 0

  for (const shift of shifts) {
    const shiftDateStr = toHKDateStr(new Date(shift.date))
    const dayPunches = effectivePunches.filter(
      (ep: any) => toHKDateStr(ep.effectiveTime) === shiftDateStr,
    )

    const clockIn = dayPunches
      .filter((ep: any) => ep.punchType === 'CLOCK_IN')
      .sort((a: any, b: any) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]

    const clockOut = dayPunches
      .filter((ep: any) => ep.punchType === 'CLOCK_OUT')
      .sort((a: any, b: any) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]

    const shiftStart = shift.startTime instanceof Date ? shift.startTime : new Date(shift.startTime)
    const shiftEnd = shift.endTime instanceof Date ? shift.endTime : new Date(shift.endTime)

    // Late — use effectiveTime
    if (clockIn && clockIn.effectiveTime.getTime() > shiftStart.getTime()) {
      lateMinutes += Math.ceil((clockIn.effectiveTime.getTime() - shiftStart.getTime()) / 60000)
    }
    // Early leave — use effectiveTime
    if (clockOut && clockOut.effectiveTime.getTime() < shiftEnd.getTime()) {
      earlyLeaveMinutes += Math.ceil((shiftEnd.getTime() - clockOut.effectiveTime.getTime()) / 60000)
    }
    // OT — use effectiveTime with per-day threshold
    if (clockOut && clockOut.effectiveTime.getTime() > shiftEnd.getTime()) {
      const dayOt = Math.floor((clockOut.effectiveTime.getTime() - shiftEnd.getTime()) / 60000)
      if (dayOt > 0 && dayOt >= otMinMinutes) {
        otMinutes += dayOt  // ≥門檻全數計；逐日判定
      }
    }
  }

  // Grab makeup entries for this month — split by targetType
  let makeupMinutes = 0
  let makeupLateMinutes = 0
  let makeupEarlyMinutes = 0
  let makeupAbsentMinutes = 0
  try {
    const makeupEntries = await db.timeBankEntry?.findMany?.({
      where: { employeeId, type: 'MAKEUP', date: { gte: monthStart, lte: monthEnd } },
    })
    for (const e of (makeupEntries || [])) {
      const m = Math.abs(e.minutes)
      if (e.targetType === 'EARLY_LEAVE') makeupEarlyMinutes += m
      else if (e.targetType === 'ABSENT') makeupAbsentMinutes += m // ← 缺勤扣OT鐘
      else makeupLateMinutes += m // 'LATE' or null (legacy) → treat as late
    }
    makeupMinutes = makeupLateMinutes + makeupEarlyMinutes + makeupAbsentMinutes // 總消耗（帳戶用）
  } catch {
    // timeBankEntry table may not exist yet
  }

  // 抓換假消耗（LEAVE_CONVERT 負消耗OT，LEAVE_SWAP_BACK 正換回OT，INIT_ADJUST/REST_TO_ACCOUNT 為帳戶調整）
  let convertedMinutes = 0
  try {
    const ADJUST_TYPES = ['LEAVE_CONVERT', 'LEAVE_SWAP_BACK', 'INIT_ADJUST', 'REST_TO_ACCOUNT']
    const convertEntries = await db.timeBankEntry?.findMany?.({
      where: { employeeId, type: { in: ADJUST_TYPES }, date: { gte: monthStart, lte: monthEnd } },
    })
    convertedMinutes = convertEntries?.reduce((s: number, e: any) => s + e.minutes, 0) || 0
  } catch {
    // timeBankEntry table may not exist yet
  }

  // 各扣各的：netLate = late - makeupLate, netEarly = earlyLeave - makeupEarly
  const netLateMinutes = Math.max(0, lateMinutes - makeupLateMinutes)
  const netEarlyMinutes = Math.max(0, earlyLeaveMinutes - makeupEarlyMinutes)
  const netDeficitMinutes = netLateMinutes + netEarlyMinutes

  // 本月淨OT = OT − 補鐘消耗 − 未補鐘的 deficit（遲到+早退）
  // makeupMinutes 已含 ABSENT，所以帳戶總消耗正確
  const netOtThisMonth = otMinutes - makeupMinutes - netDeficitMinutes

  // 拖欠 = 只看本月淨OT是否為負
  const owedMinutes = netOtThisMonth < 0 ? Math.abs(netOtThisMonth) : 0

  // 可用OT餘額 = 上月結轉 + 本月淨OT + 換假消耗（負）
  const balance = carriedFrom + netOtThisMonth + convertedMinutes
  const availableMinutes = Math.max(0, balance)
  const convertibleLeaveDays = Math.floor(availableMinutes / (9 * 60)) // 9 hours = 1 day

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

  return {
    otMinutes, lateMinutes, netLateMinutes, netEarlyMinutes, earlyLeaveMinutes, makeupMinutes,
    makeupAbsentMinutes,
    netDeficitMinutes,
    carriedFrom,
    timeAccountMinutes: balance,
    balance,
    owedMinutes,
    availableMinutes,
    convertibleLeaveDays,
    note,
  }
}

// ------------------------------------------------------------------
// 2c. Working Days with Custom Rest Days + Public Holidays
// ------------------------------------------------------------------

/**
 * Check if a date is a HK public holiday (built-in 2026 data).
 * TODO: Replace with external data source (e.g., HKPublicHoliday table or API)
 */
function isPublicHoliday(date: Date): boolean {
  const ymd = toHKDateStr(date)

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
  const { rest_days = [], count_public_holidays = false } = config
  // UTC-safe days in month
  const totalDaysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

  let restDays = 0
  let publicHolidays = 0

  for (let d = 1; d <= totalDaysInMonth; d++) {
    // UTC-safe day-of-week check
    const dow = new Date(Date.UTC(year, month, d)).getUTCDay()
    if (rest_days.includes(dow)) {
      restDays++
    }
    // isPublicHoliday now uses toHKDateStr internally — safe
    if (count_public_holidays && isPublicHoliday(new Date(Date.UTC(year, month, d)))) {
      publicHolidays++
    }
  }

  const workingDays = totalDaysInMonth - restDays - publicHolidays
  return { totalDays: totalDaysInMonth, restDays, publicHolidays, workingDays }
}

/**
 * Count rest days (weekends) in a month based on configured rest day weekdays.
 * @param year - Calendar year
 * @param month - 0-indexed month
 * @param restDays - Array of weekday numbers that are rest days (0=Sun, 6=Sat). Default [].
 */
function countRestDaysInMonth(year: number, month: number, restDays: number[] = []): number {
  const totalDaysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  let count = 0
  for (let d = 1; d <= totalDaysInMonth; d++) {
    const dow = new Date(Date.UTC(year, month, d)).getUTCDay()
    if (restDays.includes(dow)) count++
  }
  return count
}

// ------------------------------------------------------------------
// NEW: Task 2 — Count Monthly Leave Days (休息日 + 公眾假期)
// ------------------------------------------------------------------

/**
 * Count monthly leave entitlement = rest days + public holidays in a month.
 * This is the "leave you get this month" — if not taken, it can be banked.
 */
export function countMonthlyLeaveDays(
  year: number,
  month: number, // 0-indexed
  restDays: number[] = [],
): { restDayCount: number; publicHolidayCount: number; total: number } {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  let restDayCount = 0, publicHolidayCount = 0

  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(Date.UTC(year, month, d)).getUTCDay()
    if (restDays.includes(dow)) restDayCount++
    if (isPublicHoliday(new Date(Date.UTC(year, month, d)))) publicHolidayCount++ // ← 用硬編碼的 isPublicHoliday，含 7/1
  }

  return { restDayCount, publicHolidayCount, total: restDayCount + publicHolidayCount }
}

// ------------------------------------------------------------------
// NEW: Task 5 — MPF Calculation
// ------------------------------------------------------------------

/**
 * MPF (強積金) employer contribution calculation.
 */
export function calcMPF(
  relevantIncome: number,
  config: { enabled?: boolean; rate?: number; min?: number; max?: number }
): number {
  const MIN = config.min ?? 7100
  const MAX = config.max ?? 30000
  const RATE = config.rate ?? 0.05
  if (!config.enabled || relevantIncome < MIN) return 0
  const capped = Math.min(relevantIncome, MAX)
  return Math.round(capped * RATE * 100) / 100
}

// ------------------------------------------------------------------
// NEW: Task 3 & 4 — Leave Banking & OT→Leave Helpers
// ------------------------------------------------------------------

/**
 * Upsert leave balance for an employee for a given leave type and year.
 * Adds to both entitled and remaining.
 */
async function addLeaveBalance(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  days: number,
  db: any,
  mode: 'increment' | 'set' = 'increment'
): Promise<any> {
  if (mode === 'set') {
    // Set to specified value (for regeneration), preserve used
    const existing = await db.leaveBalance.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year },
      },
    })
    return db.leaveBalance.upsert({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year },
      },
      update: {
        entitled: days,
        remaining: days - (existing?.used ?? 0),
      },
      create: {
        employeeId,
        leaveTypeId,
        year,
        entitled: days,
        remaining: days,
      },
    })
  } else {
    // Original increment logic (OT conversion etc.)
    return db.leaveBalance.upsert({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year },
      },
      update: {
        entitled: { increment: days },
        remaining: { increment: days },
      },
      create: {
        employeeId,
        leaveTypeId,
        year,
        entitled: days,
        remaining: days,
      },
    })
  }
}

/**
 * Get or create TimeBank record for an employee and month.
 */
async function getOrCreateTimeBank(
  employeeId: string,
  monthDate: Date,
  db: any
): Promise<any> {
  const periodMonth = getMonthRange(monthDate).start

  let record = await db.timeBank.findUnique({
    where: {
      employeeId_periodMonth: { employeeId, periodMonth },
    },
  })

  if (!record) {
    record = await db.timeBank.create({
      data: {
        employeeId,
        periodMonth,
        otMinutes: 0,
        lateMinutes: 0,
        balance: 0,
        carriedFrom: 0,
      },
    })
  }

  return record
}

/**
 * Update TimeBank record.
 */
async function updateTimeBank(
  employeeId: string,
  monthDate: Date,
  data: { otMinutes?: number; lateMinutes?: number; carriedFrom?: number; balance?: number; monthEndNote?: string },
  db: any
): Promise<any> {
  const periodMonth = getMonthRange(monthDate).start

  return db.timeBank.update({
    where: {
      employeeId_periodMonth: { employeeId, periodMonth },
    },
    data,
  })
}

/**
 * Find or create a leave type by name (e.g., '休息日', 'OT換假').
 * LEGACY — use getLeaveTypeBySystemKey for new code.
 */
async function getOrCreateLeaveType(
  name: string,
  isPaid: boolean,
  db: any
): Promise<any> {
  let type = await db.leaveType.findFirst({
    where: { name, isActive: true },
  })

  if (!type) {
    type = await db.leaveType.create({
      data: { name, isPaid, isActive: true },
    })
  }

  return type
}

/**
 * Get leave type by systemKey (REST_DAY, ANNUAL_LEAVE, OT_LEAVE).
 * Throws if not found — system types must exist via seed.
 */
async function getLeaveTypeBySystemKey(db: any, systemKey: string): Promise<any> {
  const type = await db.leaveType.findUnique({
    where: { systemKey },
  })
  if (!type) {
    throw new Error(`System leave type '${systemKey}' not found. Run seed.`)
  }
  return type
}

/**
 * Grant monthly rest day entitlement to an employee's LeaveBalance.
 * 🔴 Fix: 差額法 — delta = quota - prevDays，舊錯誤自動修正。
 */
export async function grantMonthlyRestDays(
  employeeId: string,
  year: number,
  month: number, // 0-indexed
  quota: number,
  db: any
): Promise<void> {
  if (quota <= 0) return

  const restDayType = await getLeaveTypeBySystemKey(db, 'REST_DAY')
  if (!restDayType) return

  const grantKey = `restday_grant_${year}_${month + 1}`

  // 查上次這個月發了多少天（差額法）
  const prevGrant = await db.timeBankEntry.findFirst({
    where: {
      employeeId,
      type: 'RESTDAY_GRANT',
      note: { contains: grantKey },
    },
  })
  const prevDays = prevGrant ? Math.round(prevGrant.minutes / (24 * 60)) : 0
  const delta = quota - prevDays

  if (delta !== 0) {
    await db.leaveBalance.upsert({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: restDayType.id,
          year,
        },
      },
      update: {
        entitled: { increment: delta },
        remaining: { increment: delta },
      },
      create: {
        employeeId,
        leaveTypeId: restDayType.id,
        year,
        entitled: quota,
        used: 0,
        remaining: quota,
      },
    })
  }

  // 更新/建立標記
  if (prevGrant) {
    await db.timeBankEntry.update({
      where: { id: prevGrant.id },
      data: {
        minutes: quota * 24 * 60,
        note: `${grantKey}: 發放${quota}天休息日`,
      },
    })
  } else {
    await db.timeBankEntry.create({
      data: {
        employeeId,
        type: 'RESTDAY_GRANT',
        date: new Date(`${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01T00:00:00+08:00`),
        minutes: quota * 24 * 60,
        note: `${grantKey}: 發放${quota}天休息日`,
      },
    })
  }
}

/**
 * Ensure monthly rest day entitlement exists for the month of `targetDate`.
 * Idempotent — safe to call repeatedly. Uses delta method internally.
 */
export async function ensureRestDayGranted(employeeId: string, targetDate: Date, db: any): Promise<void> {
  const rule = await db.payRule.findFirst({
    where: { employeeId, isActive: true },
    orderBy: { effectiveFrom: 'desc' },
  })
  const config = rule?.configJson
    ? (typeof rule.configJson === 'string' ? JSON.parse(rule.configJson) : rule.configJson)
    : {}
  const restDays = config.working_days?.rest_days ?? [6, 0] // default Sat+Sun

  const { y, m } = hkParts(targetDate) // m is 0-indexed
  const quota = countMonthlyLeaveDays(y, m, restDays)
  await grantMonthlyRestDays(employeeId, y, m, quota.total, db)
}

/**
 * Wrapper for ensureRestDayGranted — grants rest day pool for the month of `monthDate`.
 * Idempotent (delta upsert + grantKey dedup). Safe to call repeatedly.
 */
export async function grantRestDaysForMonth(employeeId: string, monthDate: Date, db: any): Promise<void> {
  return ensureRestDayGranted(employeeId, monthDate, db)
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
  const { y: year, m: month } = hkParts(monthDate)

  // Get employee clinic IDs
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: { clinics: { select: { clinicId: true } } },
  })
  const clinicIds = employee
    ? employee.clinics.map((ec: any) => ec.clinicId).filter((id: string) => !clinicId || id === clinicId)
    : []

  // Load shifts first so calculateWorkedHours can use shift endTime for partial punches
  const shifts = await prisma.shift.findMany({
    where: {
      employeeId,
      date: { gte: monthStart, lte: monthEnd },
      status: { not: 'CANCELLED' },
    },
    orderBy: { date: 'asc' },
  })

  // Punch days (pass shifts for single-punch fill)
  const allPunchDays = await calculateWorkedHours(
    employeeId,
    clinicId ? [clinicId] : (clinicIds.length > 0 ? clinicIds : null),
    monthStart,
    monthEnd,
    shifts
  )

  const dailyEntries = aggregateDailyHours(allPunchDays)

  let totalWorkedHours = 0
  const attendanceDaysSet = new Set<string>()
  const partialDays: string[] = []

  for (const pd of allPunchDays) {
    totalWorkedHours += pd.hours
    if (pd.hours > 0 || pd.isPartial) attendanceDaysSet.add(pd.date)
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
    include: {
      leaveType: { select: { cancelsBonus: true, name: true, systemKey: true } },
    },
  })
  // ★ 病假不參與勤工獎條件（只看遲到+早退分鐘）
  const leaveRecordsForEngine = leaveRecords
    .filter((lr: any) => lr.leaveType?.systemKey !== 'SICK')
    .map((lr: any) => ({
      isPlanned: lr.isPlanned !== false, // default true if null (legacy)
      days: lr.days,
      cancelsBonus: lr.leaveType?.cancelsBonus ?? false,
      name: lr.leaveType?.name ?? '',
    }))

  const publicHolidays = await getPublicHolidayDays(monthStart, monthEnd)
  const publicHolidayDays = publicHolidays.length

  // Dynamic rest days: default [6, 0] (Sat+Sun); will be overridden by config at calc time
  const restDays = countRestDaysInMonth(year, month, [6, 0])
  // Total calendar days in month minus rest days minus public holidays (UTC-safe)
  const monthlyWorkingDays = hkDaysInMonth(monthDate) - restDays - publicHolidayDays
  // Fallback to old countWorkingDays for backward compat
  const workingDays = countWorkingDays(year, month)

  // Late/Early records: use getEffectivePunches (void排除 + 修正套用)
  // 🔧 Fetch MAKEUP entries — days with makeup should NOT count as late/early
  let makeupEntries: Array<{ date: string; minutes: number; note: string }> = []
  const makeupLateDates = new Set<string>()
  const makeupEarlyDates = new Set<string>()
  const makeupAbsentDates = new Map<string, number>()  // dateStr -> shiftMinutes (ABSENT)
  try {
    const rawMakeupEntries = await prisma.timeBankEntry.findMany({
      where: {
        employeeId,
        type: 'MAKEUP',
        date: { gte: monthStart, lte: monthEnd },
      },
    })
    makeupEntries = rawMakeupEntries.map((e: any) => ({
      date: toHKDateStr(e.date),
      minutes: Math.abs(e.minutes),
      note: e.note || '',
    }))
    // Split by targetType
    for (const e of rawMakeupEntries) {
      const dateStr = toHKDateStr(e.date)
      if (e.targetType === 'EARLY_LEAVE') {
        makeupEarlyDates.add(dateStr)
      } else if (e.targetType === 'ABSENT') {
        // 缺勤扣OT鐘：記錄已扣的日子和分鐘數
        makeupAbsentDates.set(dateStr, Math.abs(e.minutes))
      } else {
        // Default to LATE (backward compat for old entries without targetType)
        makeupLateDates.add(dateStr)
      }
    }
  } catch {
    // timeBankEntry may not exist yet
  }

  // 用 getEffectivePunches（作廢排除+修正套用）
  const effPunches = await getEffectivePunches(monthStart, monthEnd, { employeeId, db: prisma })

  const lateRecords: Array<{ date: string; minutes: number }> = []
  const earlyLeaveRecords: Array<{ date: string; minutes: number }> = []

  for (const shift of shifts) {
    const shiftDateStr = toHKDateStr(new Date(shift.date))
    const dayPunches = effPunches.filter(p => toHKDateStr(p.effectiveTime) === shiftDateStr)

    // 遲到：明確取「最早的上班卡」
    const clockIn = dayPunches
      .filter(p => p.punchType === 'CLOCK_IN')
      .sort((a, b) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
    const shiftStart = new Date(shift.startTime)
    if (clockIn && clockIn.effectiveTime.getTime() > shiftStart.getTime()) {
      if (!makeupLateDates.has(shiftDateStr)) {
        lateRecords.push({
          date: shiftDateStr,
          minutes: Math.ceil((clockIn.effectiveTime.getTime() - shiftStart.getTime()) / 60000),
        })
      }
    }

    // 早退：明確取「最晚的落班卡」；沒有落班卡 = 缺卡，不是早退
    const clockOut = dayPunches
      .filter(p => p.punchType === 'CLOCK_OUT')
      .sort((a, b) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]
    const shiftEnd = new Date(shift.endTime)
    if (clockOut && clockOut.effectiveTime.getTime() < shiftEnd.getTime()) {
      if (!makeupEarlyDates.has(shiftDateStr)) {
        const minutes = Math.ceil((shiftEnd.getTime() - clockOut.effectiveTime.getTime()) / 60000)
        if (minutes > 0) {
          earlyLeaveRecords.push({ date: shiftDateStr, minutes })
        }
      }
    }
  }

  // Consultation fees (for split pay)
  const consultationFees = await getConsultationRevenue(employeeId, clinicId, monthDate)

  // Compute scheduledDays and absentDays from shifts
  const scheduledDays = shifts.length
  const punchByDate: Record<string, boolean> = {}
  for (const pd of allPunchDays) {
    if (pd.hours > 0 || pd.isPartial) punchByDate[pd.date] = true
  }
  const leaveDateSet = new Set<string>()
  for (const lr of leaveRecords) {
    let current = toHKDateStr(lr.startDate)
    const endStr = toHKDateStr(lr.endDate)
    while (current <= endStr) {
      leaveDateSet.add(current)
      current = addDays(current, 1)
    }
  }

  let absentDays = 0
  const otDeductedAbsences: Array<{ date: string; minutes: number }> = []
  for (const shift of shifts) {
    const shiftDateStr = formatDate(new Date(shift.date))
    const hasPunch = punchByDate[shiftDateStr]
    const hasLeave = leaveDateSet.has(shiftDateStr)
    if (!hasPunch && !hasLeave) {
      if (makeupAbsentDates.has(shiftDateStr)) {
        // 已扣OT鐘：不計入 absentDays（不扣工資），但記錄
        otDeductedAbsences.push({ date: shiftDateStr, minutes: makeupAbsentDates.get(shiftDateStr)! })
      } else {
        absentDays++  // 正常缺勤，扣款
      }
    }
  }

  return {
    dailyEntries,
    totalWorkedHours,
    actualAttendanceDays: attendanceDaysSet.size,
    approvedLeaveDays,
    paidLeaveDays,
    publicHolidayDays,
    workingDays,
    restDays,
    totalDaysInMonth: hkDaysInMonth(monthDate),
    monthlyWorkingDays,
    lateRecords,
    earlyLeaveRecords,
    leaveRecords: leaveRecordsForEngine,
    partialDays,
    consultationFees,
    scheduledDays,
    absentDays,
    otDeductedAbsences,
    shifts,
    makeupEntries,
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
  // Monthly pay multiplier: scale base salary by clinic coverage (default 1.0)
  const monthlyPayMultiplier = config.monthly_pay_multiplier ?? 1

  const unpaidLeaveDays = workData.approvedLeaveDays - workData.paidLeaveDays
  // absence_basis: 'scheduled' (default) = only scheduled shift days, 'monthly' = full month working days
  const absenceBasis = config.absence_basis ?? 'scheduled'
  const expectedWorkDays = absenceBasis === 'scheduled'
    ? workData.scheduledDays
    : (workData.monthlyWorkingDays ?? workData.workingDays)
  // Use shift-based absentDays from collectWorkData (scheduled shifts with no punch and no leave)
  const absentDays = workData.absentDays ?? Math.max(
    0,
    expectedWorkDays - workData.actualAttendanceDays - unpaidLeaveDays - workData.publicHolidayDays
  )

  // ✅ 模型 A：底薪 = 全額月薪（不按出勤比例縮水），缺勤才扣
  // 之前錯誤：basePay 按 (paidDays/workingDays) 縮水 + deduction 再扣一次 = 同一件事扣兩次
  const workingDays = workData.workingDays
  const basePay = monthlySalary * monthlyPayMultiplier  // 全額底薪，不縮水
  // HK Statutory: dailyRate = monthlySalary × 12 ÷ 365
  const dailyRate = statutoryDailyWage(monthlySalary)
  const deduction = (absentDays + unpaidLeaveDays) * dailyRate * deductionRate

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
    totalPayable: Math.max(0, basePay - deduction + otPay), // 防止負數（最後防線，正常不該觸發）
    absentDays,
    otHours,
    workedHours: workData.totalWorkedHours,
    leaveDays: workData.approvedLeaveDays,
    detail: {
      baseType: 'monthly',
      monthlySalary,
      monthlyPayMultiplier,
      workingDays: workData.workingDays,
      scheduledDays: workData.scheduledDays,
      actualAttendanceDays: workData.actualAttendanceDays,
      approvedLeaveDays: workData.approvedLeaveDays,
      paidLeaveDays: workData.paidLeaveDays,
      unpaidLeaveDays,
      publicHolidayDays: workData.publicHolidayDays,
      absentDays,
      lateRecords: workData.lateRecords,
      deductionRate,
      otThreshold,
      otHours,
      hourlyEquivalent,
      otMultiplier,
      absenceBasis,
      expectedWorkDays,
      dailyWage: Math.round(dailyRate * 100) / 100,
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
      scheduledDays: workData.scheduledDays,
      actualAttendanceDays: workData.actualAttendanceDays,
      absentDays: workData.absentDays,
      lateRecords: workData.lateRecords,
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
      scheduledDays: workData.scheduledDays,
      actualAttendanceDays: workData.actualAttendanceDays,
      absentDays: workData.absentDays,
      lateRecords: workData.lateRecords,
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
    const absenceBasis = config.absence_basis ?? 'scheduled'
    const expectedWorkDays = absenceBasis === 'scheduled'
      ? workData.scheduledDays
      : (workData.monthlyWorkingDays ?? workData.workingDays)
    const absentDays = workData.absentDays ?? Math.max(
      0,
      expectedWorkDays - workData.actualAttendanceDays - (workData.approvedLeaveDays - workData.paidLeaveDays) - workData.publicHolidayDays
    )
    deduction = absentDays * statutoryDailyWage(basePay) * deductionRate
  }

  return {
    basePay,
    otPay: 0,
    splitPay,
    attendanceBonus: 0,
    attendanceBonusCancelled: false,
    deduction,
    totalPayable: basePay - deduction + splitPay,
    absentDays: workData.absentDays ?? 0,
    otHours: 0,
    workedHours: workData.totalWorkedHours,
    leaveDays: workData.approvedLeaveDays,
    detail: {
      baseType: 'split',
      splitRatio,
      consultationFees,
      splitPay,
      scheduledDays: workData.scheduledDays,
      absentDays: workData.absentDays,
      lateRecords: workData.lateRecords,
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
  modConfig: { amount: number; cancel_if: { late_minutes_exceed?: number; late_is_cumulative?: boolean; any_unplanned_leave?: boolean; any_absence?: boolean } },
  result: PayrollResult,
  workData: WorkData
): PayrollResult {
  // ★ 缺勤扣OT鐘也取消勤工（即使 absentDays 已排除 OT-deducted 的天數）
  if (workData.otDeductedAbsences && workData.otDeductedAbsences.length > 0) {
    const next = { ...result }
    next.attendanceBonus = 0
    next.attendanceBonusCancelled = true
    next.attendanceBonusReason = '缺勤（已扣OT鐘），取消勤工'
    const rawTotal = result.basePay - result.deduction + result.otPay + (result.splitPay || 0)
    next.totalPayable = Math.max(0, rawTotal)
    next.detail = { ...result.detail, attendanceBonus: 0, attendanceBonusCancelled: true, attendanceBonusReason: '缺勤（已扣OT鐘），取消勤工', rawTotal: Math.round(rawTotal * 100) / 100 }
    return next
  }

  const bonus = evaluateAttendanceBonus(modConfig, {
    lateRecords: workData.lateRecords.map(r => ({ minutes: r.minutes })),
    earlyRecords: workData.earlyLeaveRecords.map(r => ({ minutes: r.minutes })),
    leaveRecords: workData.leaveRecords,
    absentDays: workData.absentDays,
  })

  const next = { ...result }
  next.attendanceBonus = bonus.amount
  next.attendanceBonusCancelled = bonus.cancelled
  next.attendanceBonusReason = bonus.reason
  const rawTotal = result.basePay - result.deduction + result.otPay + (result.splitPay || 0) + bonus.amount
  next.totalPayable = Math.max(0, rawTotal)
  next.detail = { ...result.detail, attendanceBonus: bonus.amount, attendanceBonusCancelled: bonus.cancelled, attendanceBonusReason: bonus.reason, rawTotal: Math.round(rawTotal * 100) / 100 }
  return next
}

function applyOvertimeModifier(
  modConfig: { mode: 'pay' | 'time_off'; multiplier?: number; threshold?: number; hours_per_leave_day?: number },
  result: PayrollResult,
  _workData: WorkData
): PayrollResult {
  const next = { ...result }
  if (modConfig.mode === 'time_off') {
    // OT converted to time off — no monetary OT pay
    next.otPay = 0
    next.totalPayable = result.basePay - result.deduction + (result.splitPay || 0) + result.attendanceBonus
    next.detail = { ...result.detail, otMode: 'time_off', otHoursOff: result.otHours, hoursPerLeaveDay: modConfig.hours_per_leave_day ?? 9 }
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
// Simple Hourly Pay — Part-time (no modifiers, no OT, no MPF)
// Formula: 有效分鐘 × 時薪 ÷ 60, 早打卡從排班開始起計
// ------------------------------------------------------------------

async function calculateSimpleHourlyPay(
  employeeId: string,
  monthDate: Date,
  clinicId: string | null,
  config: PayRuleConfigModular
): Promise<PayrollResult> {
  const rate = config.hourly_rate || 0
  const { start: monthStart, end: monthEnd } = getMonthRange(monthDate)

  const shifts = await prisma.shift.findMany({
    where: {
      employeeId,
      date: { gte: monthStart, lte: monthEnd },
      status: { not: 'CANCELLED' },
    },
  })

  // Use effective punches (corrections applied, voided excluded)
  const effectivePunches = await getEffectivePunches(monthStart, monthEnd, { employeeId })

  const days: any[] = []
  let totalMinutes = 0
  let totalPay = 0

  // Group effective punches by HK date (effectiveTime)
  const byDate = new Map<string, any[]>()
  for (const ep of effectivePunches) {
    const d = toHKDateStr(ep.effectiveTime)
    if (!byDate.has(d)) byDate.set(d, [])
    byDate.get(d)!.push(ep)
  }

  for (const [dateStr, dayPunches] of byDate) {
    const shift = shifts.find((s: any) => toHKDateStr(s.date) === dateStr)
    const clockIn = dayPunches.filter((ep: any) => ep.punchType === 'CLOCK_IN')[0]
    const clockOut = dayPunches.filter((ep: any) => ep.punchType === 'CLOCK_OUT').slice(-1)[0]

    if (!clockIn || !clockOut) {
      days.push({ date: dateStr, note: '缺卡，不計薪', minutes: 0, amount: 0 })
      continue
    }

    // ★ Core: effective start = max(clockIn, shiftStart) — early punch not counted
    const shiftStart = shift ? new Date(shift.startTime).getTime() : null
    const effStart = shiftStart
      ? Math.max(clockIn.effectiveTime.getTime(), shiftStart)
      : clockIn.effectiveTime.getTime()
    const minutes = Math.max(0, Math.floor((clockOut.effectiveTime.getTime() - effStart) / 60000))
    const amount = Math.round(minutes * rate / 60 * 100) / 100

    totalMinutes += minutes
    totalPay += amount

    days.push({
      date: dateStr,
      in: clockIn.effectiveTime,
      out: clockOut.effectiveTime,
      shiftStart: shift?.startTime ?? null,
      clamped: shiftStart != null && clockIn.effectiveTime.getTime() < shiftStart,
      minutes,
      amount,
    })
  }

  totalPay = Math.round(totalPay * 100) / 100

  // Count absentDays (scheduled shift with no effective punch)
  const absentDays = shifts.filter((s: any) => {
    const ds = toHKDateStr(s.date)
    return !byDate.has(ds) || byDate.get(ds)!.length === 0
  }).length

  return {
    basePay: totalPay,
    otPay: 0,
    splitPay: null,
    attendanceBonus: 0,
    attendanceBonusCancelled: false,
    deduction: 0,
    totalPayable: totalPay,
    absentDays,
    otHours: 0,
    workedHours: Math.round(totalMinutes / 60 * 100) / 100,
    leaveDays: 0,
    detail: {
      payType: 'HOURLY',
      hourlyRate: rate,
      totalMinutes,
      days,
    },
  }
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
  config: PayRuleConfigModular,
  options?: { storeBonus?: number } // 店舖獎金，預設 0；只有月薪路徑會收到
): Promise<PayrollResult> {
  // ★ Part-time hourly: bypass all modifier logic entirely
  if (config.base_type === 'hourly') {
    return calculateSimpleHourlyPay(employeeId, monthDate, clinicId, config)
  }

  const { y: year, m: month } = hkParts(monthDate)
  const { start: monthStart, end: monthEnd } = getMonthRange(monthDate)

  // 1. Collect work data
  const workData = await collectWorkData(employeeId, monthDate, clinicId)

  // 2. Run base module
  const baseResult = runBaseModule(config, workData)

  // 3. Apply modifiers in order
  let result: PayrollResult = baseResult
  const mods = config.modifiers || {}

  // Defensive: merge root-level cancel_if into mods.attendance_bonus.cancel_if
  // (legacy configs may have cancel_if at root instead of nested)
  if (mods.attendance_bonus && (config as any).cancel_if) {
    const rootCancelIf = (config as any).cancel_if
    const nestedCancelIf = mods.attendance_bonus.cancel_if || {}
    mods.attendance_bonus.cancel_if = { ...rootCancelIf, ...nestedCancelIf }
  }

  if (mods.attendance_bonus) {
    result = applyAttendanceBonusModifier(mods.attendance_bonus, result, workData)
  }
  if (mods.overtime) {
    result = applyOvertimeModifier(mods.overtime, result, workData)
  }
  if (mods.allowances && mods.allowances.length > 0) {
    result = applyAllowancesModifier(mods.allowances, result)
  }

  // 4. Task 5: Apply MPF deduction
  const allowances = mods.allowances || []
  const totalAllowances = allowances.reduce((sum, a) => sum + a.amount, 0)
  const storeBonus = options?.storeBonus ?? 0

  // ★ 病假扣減：只在 MONTHLY 分支接線（時薪員工天然零成本）
  const sickDeduction = (result.detail as any)?.monthlySalary != null
    ? await computeSickDeduction(employeeId, monthStart, monthEnd, (result.detail as any).monthlySalary, config.deduction_rate ?? 1, prisma)
    : { amount: 0, episodes: [] }

  const grossPay = result.basePay - result.deduction + result.otPay + (result.splitPay || 0) + result.attendanceBonus + storeBonus + totalAllowances - sickDeduction.amount

  const mpfConfig = mods.mpf || config.mpf || { enabled: false }
  const mpf = calcMPF(grossPay, mpfConfig)
  const netPay = Math.max(0, grossPay - mpf)

  result.totalPayable = netPay
  result.detail = { ...result.detail, storeBonus, grossPay: Math.round(grossPay * 100) / 100, mpf, mpfRate: (mods.mpf || config.mpf || {}).rate ?? 0.05, netPay: Math.round(netPay * 100) / 100, sickDeduction: sickDeduction.amount, sickEpisodes: sickDeduction.episodes }

  // 5. Task 2: Count monthly leave days
  const restDaysConfig = mods.working_days?.rest_days ?? [6, 0] // 預設週六日
  const monthlyLeaveDays = countMonthlyLeaveDays(year, month, restDaysConfig)

  // 6. Task 3 + Rest Day System: Grant monthly rest day entitlement
  // monthlyLeaveDays.total = restDays (weekends) + publicHolidays
  // This is now a proper LeaveBalance entry that can be used/accumulated
  await grantMonthlyRestDays(employeeId, year, month, monthlyLeaveDays.total, prisma)
  let leaveBalanceRemaining = 0 // Tracked via LeaveBalance, not inline

  // 🔑 OT 唯一來源：時間銀行 otMinutes（排班外工時，分鐘制）
  // 提前呼叫 calculateTimeBank，後續 OT→Leave / 明細都用同一結果
  const timeBankConfig = mods.time_bank || { negative_carry: 'reset' }
  const tb = await calculateTimeBank(employeeId, monthDate, timeBankConfig, prisma)
  result.otHours = tb.otMinutes / 60 // 從分鐘換算，不自己算

  // 🔑 重新計算 otPay — 之前用門檻制 otHours 算錯，現在用時間銀行 otMinutes 換算的小時數
  {
    const hourlyEquivalent = (result.detail as any).hourlyEquivalent ?? 0
    const otMultiplier = (result.detail as any).otMultiplier ?? 1.5
    const oldOtPay = result.otPay
    result.otPay = Math.round(result.otHours * hourlyEquivalent * otMultiplier * 100) / 100
    const grossPayDelta = result.otPay - oldOtPay
    const oldGrossPay = (result.detail as any).grossPay ?? (result.basePay - result.deduction + oldOtPay + (result.splitPay || 0) + result.attendanceBonus)
    const newGrossPay = oldGrossPay + grossPayDelta
    const mpfConfig = mods.mpf || config.mpf || { enabled: false }
    const newMpf = calcMPF(newGrossPay, mpfConfig)
    const newNetPay = Math.max(0, newGrossPay - newMpf)
    result.totalPayable = newNetPay
    result.detail = {
      ...result.detail,
      grossPay: Math.round(newGrossPay * 100) / 100,
      mpf: newMpf,
      netPay: Math.round(newNetPay * 100) / 100,
    }
  }

  // 7. Task 4: OT Balance only (no auto-convert; boss handles via /api/timebank/convert)
  {
    const otMinutesFromResult = tb.otMinutes
    const timeBank = await getOrCreateTimeBank(employeeId, monthDate, prisma)

    // deficit = 遲到 + 早退，補鐘統一抵扣（用 tb 計算結果）
    const deficitMinutes = tb.lateMinutes + tb.earlyLeaveMinutes
    const netDeficitMinutes = Math.max(0, deficitMinutes - tb.makeupMinutes)

    // carriedFrom — recursive backfill
    const carriedFrom = await getCarriedFrom(employeeId, monthDate, prisma)

    // 可用OT = OT − 補鐘消耗 − 淨 deficit + 上月結轉
    const netOtMinutes = otMinutesFromResult
      - tb.makeupMinutes       // 補鐘消耗OT
      - netDeficitMinutes      // 未補鐘 deficit（遲到+早退）扣OT
      + carriedFrom            // 上月結轉

    // 只存餘額，不換假
    await updateTimeBank(employeeId, monthDate, {
      otMinutes: otMinutesFromResult,
      balance: Math.max(0, netOtMinutes),
      carriedFrom,
      monthEndNote: `本月OT結餘 ${Math.max(0, netOtMinutes)} 分鐘`,
    }, prisma)
  }

  // 8. Task 6 + TimeBank: Build comprehensive detail JSON with timebank data
  // tb already computed at line 1992 (OT唯一來源)
  const lateCount = workData.lateRecords.length
  const earlyLeaveCount = workData.earlyLeaveRecords?.length ?? 0

  const leaveTaken = workData.approvedLeaveDays
  result.detail = {
    ...result.detail,
    // 出勤
    attendance: {
      expectedWorkDays: workData.scheduledDays,
      actualAttendanceDays: workData.actualAttendanceDays,
      absentDays: workData.absentDays,
      otDeductedAbsences: workData.otDeductedAbsences || [],
      lateRecords: workData.lateRecords,
      earlyLeaveRecords: workData.earlyLeaveRecords || [],
      dailyEntries: workData.dailyEntries.map(d => ({ date: d.date, totalHours: d.totalHours })),
    },
    // 🔧 Fix #2: 補鐘記錄
    makeupRecords: workData.makeupEntries || [],
    // 薪資
    salary: {
      basePay: Math.round(result.basePay * 100) / 100,
      deduction: Math.round(result.deduction * 100) / 100,
      dailyWage: (result.detail as any).dailyWage ?? 0,
      deductionRate: config.deduction_rate ?? 1,
      attendanceBonus: Math.round(result.attendanceBonus * 100) / 100,
      otPay: Math.round(result.otPay * 100) / 100,
      allowances: Math.round(totalAllowances * 100) / 100,
      sickDeduction: sickDeduction.amount,
      sickEpisodes: sickDeduction.episodes,
      grossPay: Math.round(grossPay * 100) / 100,
      mpf: Math.round(mpf * 100) / 100,
      mpfRate: (mods.mpf || config.mpf || {}).rate ?? 0.05,
      netPay: Math.round(netPay * 100) / 100,
    },
    // 假期與 OT
    leaveAndOt: {
      monthlyLeaveDays: monthlyLeaveDays.total,
      leaveTaken,
      leaveBalance: leaveBalanceRemaining,
      otHours: Math.round(result.otHours * 100) / 100,
      otBalanceMinutes: tb.balance ?? 0,
    },
    // 🔴 Fix #1: 統一遲到/OT資料源 — timebank 從計糧引擎計算，薪資明細全部從此取
    timebank: {
      otMinutes: tb.otMinutes,
      lateMinutes: tb.lateMinutes,
      lateCount,
      netLateMinutes: tb.netLateMinutes,
      earlyLeaveMinutes: tb.earlyLeaveMinutes,
      earlyLeaveCount,
      netEarlyMinutes: tb.netEarlyMinutes,
      owedMinutes: tb.owedMinutes,
      convertibleLeaveDays: tb.convertibleLeaveDays,
      makeupMinutes: tb.makeupMinutes,
      carriedFrom: tb.carriedFrom,
      balance: tb.balance,
      timeAccountMinutes: tb.timeAccountMinutes,
      netDeficitMinutes: tb.netDeficitMinutes,
    },
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

// ------------------------------------------------------------------
// Confidentiality Masking (server-side enforcement)
// ------------------------------------------------------------------

/**
 * Mask financial fields for a payroll item if the employee's salary is confidential
 * and the requesting user is not OWNER. Attendance stats (workedHours, otHours,
 * leaveDays, absentDays) are preserved so managers can still see performance.
 *
 * @returns the item with `confidential: true` flag if masked
 */
export function maskIfConfidential(item: any, role: string): any {
  const isOwner = role === 'OWNER'
  const isConfidential = item.employee?.payConfidential === true

  if (isOwner || !isConfidential) {
    return item
  }

  return {
    ...item,
    confidential: true,
    // Mask all monetary fields — attendance stats remain visible
    basePay: null,
    otPay: null,
    splitPay: null,
    deduction: null,
    storeBonus: null,
    totalPayable: null,
    detailJson: null,
  }
}

/**
 * Check if any items in a run are confidential for a given role.
 * If true, the summary totals must also be masked to prevent reverse-engineering.
 */
export function hasConfidentialItems(items: any[], role: string): boolean {
  const isOwner = role === 'OWNER'
  if (isOwner) return false
  return items.some((item: any) => item.employee?.payConfidential === true)
}
