// ============================================================
// Payroll Engine — Phase 6 (Audit-Fixed) + Full Payroll Rules
// Parametric salary calculation from PayRule.configJson
// Sources: PunchRecord (corrected), LeaveRequest, Shift, HKPublicHoliday
// Fixes: paired hours, cross-clinic OT, clinicId corrections,
//        single-punch pending, parametric OT thresholds,
//        consultation revenue lookup
// ============================================================

import { prisma, basePrisma } from './prisma'
import { QUOTA_LEAVE_KEYS } from './leave-types'
import { getEffectivePunches } from './punch-query'
import { toHKDateStr, getMonthRange, hkDaysInMonth, hkDayOfWeek, hkDateStart, hkDateEnd, addDays, hkParts, leaveCoversDate } from './hk-date'
import { matchPunchesToShifts, diffMinutes } from './shift-punch-match'
import type { PayType, RunStatus } from '@prisma/client'
import { getEffectiveADW } from './adw'
import type { ADWResult, AdwPolicyResult } from './adw'
import { calculateMaternityPay, calculatePaternityPay, filterHolidaysExcludingMaternity } from './maternity'

// ------------------------------------------------------------------
// TimeBank Engine Version + Cache Key
// ------------------------------------------------------------------
/**
 * ★ Bump this version whenever calculateTimeBank logic changes.
 *   TimeBank cache entries with mismatched versions are auto-invalidated.
 */
const TIMEBANK_ENGINE_VERSION = 3 // v3: 分更時間窗 + floor 取整

// ★ 2026-08-09: Module-level flag — EARLY_IN_OT catch log-once
const earlyInOtWarnedSet = new Set<string>()

/**
 * ★ Fingerprint must reflect the employee's real pay rule config.
 *   Old version received config from caller, but the payroll path passed
 *   mods.time_bank (only negative_carry, no .modifiers), making the key
 *   always the null combination — equivalent to cacheKey being useless,
 *   and the key written by payroll differed from overview, causing mutual invalidation.
 */
async function timeBankCacheKey(db: any, employeeId: string, monthEnd: Date, monthStart: Date): Promise<string> {
  let cfg: any = {}
  try {
    const rule = await db.payRule.findFirst({
      where: {
        employeeId, isActive: true,
        effectiveFrom: { lte: monthEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    })
    if (rule?.configJson) {
      cfg = typeof rule.configJson === 'string' ? JSON.parse(rule.configJson) : rule.configJson
    }
  } catch { /* 壞 JSON 當冇 config */ }

  // ★ 只 hash 會影響【時間帳戶分鐘數】嘅 config。
  //   金額類（monthly_salary / deduction_rate）唔影響分鐘，唔使入。
  //   將來加新 config 時問一句：改咗佢，同一批打卡會唔會算出唔同分鐘？
  //   會 → 要加入指紋；唔會 → 唔使。
  return `v${TIMEBANK_ENGINE_VERSION}:` + JSON.stringify({
    ot: cfg?.modifiers?.overtime ?? null,
    lunch: cfg?.modifiers?.lunch_break ?? null,
    rest: cfg?.working_days?.rest_days ?? null,
  })
}

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
 * ⚠️ 呢個【唔係】扣薪日率。
 *
 * 月薪 × 12 ÷ 365 只係 ADW 喺「固定月薪 + 過去 12 個月無剔除期間」之下嘅化簡值。
 * 一旦有 ≥4 天病假（4/5 糧）、無薪假等剔除期間，就唔成立 —— 必須用 calculateADW()。
 *
 * 用途：只作為 calculateADW() 失敗時嘅 fallback。
 * 扣薪請用 deductionDailyRate()。
 *
 * @deprecated Use calculateADW from './adw' for EO-compliant ADW-based calculations.
 * Kept as fallback when ADW data is insufficient.
 */
export function statutoryDailyWage(monthlySalary: number): number {
  return (monthlySalary * 12) / 365
}

/**
 * 【扣薪日率】
 *
 * ★ 2026-08-02 決定：改用 'workday'（《臻善牙科員工守則》4.2）
 *   「每月工作日數為該月總日數，扣除星期六、星期日及法定假日。」
 *   注意係【數目】唔係【日期】—— 輪班制之下實際休息日由更表決定，
 *   但分母一律用「該月六日數 + 公眾假期數」去扣。
 *
 * ★ 唔可以用 statutoryDailyWage（月薪×12÷365）—— 嗰個係 ADW 嘅化簡值，
 *   屬法定權益公式，唔係扣薪標準。
 */
export function deductionDailyRate(
  monthlySalary: number,
  monthDate: Date,
  mode: 'calendar' | 'fixed30' | 'workday' = 'workday',
  monthlyWorkingDays?: number,
): number {
  if (mode === 'fixed30') return monthlySalary / 30
  if (mode === 'workday') {
    // ★ 必須由呼叫者傳入 —— 佢要讀 pay rule 嘅 rest_days config，
    //   喺呢個純函數入面計唔到。傳唔到就 fallback 去曆日（安全側：扣少啲）。
    if (monthlyWorkingDays && monthlyWorkingDays > 0) return monthlySalary / monthlyWorkingDays
    const days = hkDaysInMonth(monthDate)
    return days > 0 ? monthlySalary / days : monthlySalary / 30
  }
  const days = hkDaysInMonth(monthDate)   // 6月=30、7月=31
  return days > 0 ? monthlySalary / days : monthlySalary / 30
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
  shifts?: Array<{ date: Date | string; clinicId?: string; secondaryClinicId?: string | null; startTime?: Date | string; endTime?: Date | string }>
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
      orderBy: [{ createdAt: 'asc' }],
    }),
  ])

  // Build correction map keyed by punchRecordId (not date:clinicId:type).
  // Old key would let one correction overwrite all same-type punches on the same day,
  // and two corrections for the same slot give non-deterministic order → inconsistent payroll.
  const correctionByRecordId = new Map<string, Date>()
  const orphanCorrections: typeof corrections = [] // punchRecordId = null: pure correction with no original record
  for (const c of corrections) {
    if (c.punchRecordId) correctionByRecordId.set(c.punchRecordId, c.correctedTime)
    else orphanCorrections.push(c)
  }

  // Group punches by date + clinic
  interface DayClinicEntry {
    clinicId: string
    punchIns: Date[]
    punchOuts: Date[]
  }
  const dayClinicMap = new Map<string, DayClinicEntry>()

  for (const p of punches) {
    // Use correction time if a correction maps to this punch record
    const effectiveTime = correctionByRecordId.get(p.id) ?? p.punchTime
    const dayKey = formatDate(effectiveTime)
    const mapKey = `${dayKey}:${p.clinicId}`
    let entry = dayClinicMap.get(mapKey)
    if (!entry) {
      entry = { clinicId: p.clinicId, punchIns: [], punchOuts: [] }
      dayClinicMap.set(mapKey, entry)
    }
    // Only CLOCK_IN / CLOCK_OUT participate in pairing
    if (p.punchType === 'CLOCK_IN') entry.punchIns.push(effectiveTime)
    else if (p.punchType === 'CLOCK_OUT') entry.punchOuts.push(effectiveTime)
  }

  // Pure corrections (no original punch record) → inject a synthetic entry
  for (const c of orphanCorrections) {
    if (c.punchType !== 'CLOCK_IN' && c.punchType !== 'CLOCK_OUT') continue
    const dayStr = formatDate(c.correctedTime)
    const mapKey = `${dayStr}:${c.clinicId}`
    let entry = dayClinicMap.get(mapKey)
    if (!entry) {
      entry = { clinicId: c.clinicId, punchIns: [], punchOuts: [] }
      dayClinicMap.set(mapKey, entry)
    }
    if (c.punchType === 'CLOCK_IN') entry.punchIns.push(c.correctedTime)
    else entry.punchOuts.push(c.correctedTime)
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
    let isPartial = (hasIn && !hasOut) || (!hasIn && hasOut)

    // ★ 決定 2：調鋪唔打離店卡係正常流程 ——
    //   同日喺【另一間店】仲有更，就唔當 A 店缺卡，避免考勤異常報表日日出現調鋪日。
    //   ★ 調鋪方案 1：secondaryClinicId 嘅更（一張更兩間店）都唔當缺卡。
    if (hasIn && !hasOut && shifts && shifts.length > 0) {
      const hasOtherClinicShiftToday = shifts.some(s =>
        toHKDateStr(new Date(s.date)) === dayStr &&
        ((s.clinicId && s.clinicId !== clinicId) || s.secondaryClinicId === clinicId)
      )
      if (hasOtherClinicShiftToday) isPartial = false
    }

    // ★ 調鋪唔打離店卡：A 店只有 IN 冇 OUT，要用【A 店嗰張更】嘅收工時間補足。
    //   ★ 調鋪方案 1：亦要揾到 secondaryClinicId 匹配 A 店嘅更。
    if (hasIn && !hasOut && lastIn && shifts && shifts.length > 0) {
      const inTime = lastIn.getTime()
      const dayShifts = shifts.filter(s =>
        toHKDateStr(new Date(s.date)) === dayStr &&
        (s.clinicId === clinicId || s.secondaryClinicId === clinicId) &&
        s.endTime
      )
      // 揀開工時間最接近呢個上班卡嗰張
      const shiftForDay = dayShifts.sort((a, b) =>
        Math.abs(new Date(a.startTime ?? a.date).getTime() - inTime) -
        Math.abs(new Date(b.startTime ?? b.date).getTime() - inTime)
      )[0]
      if (shiftForDay?.endTime) {
        const endTime = new Date(shiftForDay.endTime)
        // 收工唔可以早過上班
        if (endTime.getTime() > inTime) {
          totalMs = endTime.getTime() - inTime
          lastIn = null
        }
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
): Promise<{
  totalDays: number
  byType: Array<{
    leaveTypeName: string
    days: number
    dates: string[] // ★ 新增：畀 paidLeaveDays 同 restDayDates 用
    isPaid: boolean
    systemKey: string | null
  }>
}> {
  const leaves = await prisma.leaveRequest.findMany({
    where: {
      employeeId,
      status: 'APPROVED',
      startDate: { lte: monthEnd },
      endDate: { gte: monthStart },
    },
    include: {
      leaveType: { select: { name: true, isPaid: true, systemKey: true } },
    },
  })

  // ★ 2026-08-02: 同一日可以有多筆假期（病假覆蓋休息日）——
  //   逐筆 += overlapDays 會重複計，令 approvedLeaveDays 虛高、
  //   unpaidLeaveDays 變負數。改為按【日期】去重。
  const allLeaveDates = new Set<string>()
  const byType: Array<{
    leaveTypeName: string
    days: number
    dates: string[]
    isPaid: boolean
    systemKey: string | null
  }> = []

  for (const leave of leaves) {
    const effectiveStart = new Date(Math.max(leave.startDate.getTime(), monthStart.getTime()))
    const effectiveEnd = new Date(Math.min(leave.endDate.getTime(), monthEnd.getTime()))

    const dates: string[] = []
    let current = toHKDateStr(effectiveStart)
    const endStr = toHKDateStr(effectiveEnd)
    while (current <= endStr) {
      dates.push(current)
      allLeaveDates.add(current)
      current = addDays(current, 1)
    }

    // ★ 分類仍然按各自日數（病假計算要知實際幾多日）
    byType.push({
      leaveTypeName: leave.leaveType.name,
      days: dates.length,
      dates,
      isPaid: leave.leaveType.isPaid,
      systemKey: leave.leaveType.systemKey,
    })
  }

  return { totalDays: allLeaveDates.size, byType } // ★ 去重後
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
  monthDate: Date,                                  // ★ 用嚟算當月曆日數
  deductionBasis: 'calendar' | 'fixed30' | 'workday' = 'workday',
  adwPolicy?: { floor_at_current_salary?: boolean; cap_at_current_salary?: boolean },   // ★ ADW 薪金調整政策
  monthlyWorkingDays?: number,                      // ★ workday 模式需要
): Promise<{
  amount: number;
  paidAmount: number;      // ★ 病假期間實收工資（供 ADW excludedWage）
  episodes: Array<{
    range: string; totalDays: number; daysInMonth: number; deductDays: number; rate: number;
    adw?: number; adwSource?: 'calculated' | 'fallback';
    adwPolicyApplied?: 'none' | 'floor' | 'cap'; adwRaw?: number;
    dailyDeduct?: number; sicknessAllowance?: number; alreadyInBase?: number; deductionAmount?: number;
  }>;
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
  if (sickLeaves.length === 0) return { amount: 0, paidAmount: 0, episodes: [] }

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

  // ★ 該員工當月有排更嘅日期（fallback 用）
  const shifts = await db.shift.findMany({
    where: {
      employeeId,
      date: { gte: monthStart, lte: monthEnd },
      status: { not: 'CANCELLED' },
    },
    select: { date: true },
  })
  const scheduledDateSet = new Set<string>(shifts.map((s: any) => toHKDateStr(new Date(s.date))))

  // ★ 2026-08-02: 該月休息日日期集（準則 B）
  //   排班制之下「冇排更」有兩種意思：
  //     ① 排咗休息日 → 唔應該扣（本來就唔使返工）
  //     ② 更表未排／漏咗 → 應該扣（本來要返工，只係更表未填）
  //   所以唔可以單靠「有冇 shift」，要睇有冇明確嘅休息日記錄。
  const restDayLeaves = await db.leaveRequest.findMany({
    where: {
      employeeId,
      status: 'APPROVED',
      leaveType: { systemKey: 'REST_DAY' },
      startDate: { lte: monthEnd },
      endDate: { gte: monthStart },
    },
    select: { startDate: true, endDate: true },
  })
  const restDayDates = new Set<string>()
  for (const rl of restDayLeaves) {
    let cur = toHKDateStr(rl.startDate)
    const last = toHKDateStr(rl.endDate)
    while (cur <= last) { restDayDates.add(cur); cur = addDays(cur, 1) }
  }

  // 逐段結算（只扣落在本月的日子；檔位看整段）
  // ★ 扣薪日率（工作日分母）—— 同缺勤／無薪假用同一個基準
  const dailyDeduct = deductionDailyRate(monthlySalary, monthDate, deductionBasis, monthlyWorkingDays)

  // ★ ADW compliance — ≥4 days: 同 ADW×80% 比較；<4 days: 當無薪缺勤，按扣薪日率全額扣
  const mStart = toHKDateStr(monthStart), mEnd = toHKDateStr(monthEnd)
  let amount = 0
  let paidAmount = 0
  const detail: Array<{
    range: string;
    totalDays: number;
    daysInMonth: number;
    deductDays: number;
    rate: number;
    adw?: number;
    adwSource?: 'calculated' | 'fallback';
    adwPolicyApplied?: 'none' | 'floor' | 'cap';
    adwRaw?: number;
    dailyDeduct?: number;
    sicknessAllowance?: number;
    alreadyInBase?: number;
    deductionAmount?: number;
    warnings?: string[];
  }> = []
  for (const ep of episodes) {
    const inMonth = ep.filter(d => d >= mStart && d <= mEnd)
    if (inMonth.length === 0) continue

    // ★ 津貼日數：全部病假日（方案 1，EO 4/5 糧唔跟工作日縮）
    const allowanceDays = inMonth.length

    // ★ 2026-08-02: 準則 B + 過渡保護
    //   B: 冇休息日記錄就扣；A fallback: 冇排更就扣（更表未排時）
    const hasAnyRestDay = restDayDates.size > 0
    const deductDays = hasAnyRestDay
      ? inMonth.filter(d => !restDayDates.has(d)).length // B: 冇休息日記錄就扣
      : inMonth.filter(d => scheduledDateSet.has(d)).length // A: fallback（更表未排）
    const _ymKey = toHKDateStr(monthDate).slice(0, 7)
    const _fallbackWarning = !hasAnyRestDay && inMonth.length > 0
      ? [`🟡 ${_ymKey} 冇休息日記錄，病假扣款按「有排更」計算 —— 請確認更表已排`]
      : []

    if (ep.length >= 4) {
      // ★ EO: ≥4 consecutive days = 疾病日 → 4/5 ADW
      // Use 【該段首天】 as specified date
      const episodeFirstDay = new Date(ep[0] + 'T00:00:00+08:00')
      let adwValue: number
      let adwSource: 'calculated' | 'fallback' = 'calculated'
      let adwWarnings: string[] = []
      let adwPolicyApplied: 'none' | 'floor' | 'cap' = 'none'
      let adwRawValue: number | undefined

      try {
        const eff = await getEffectiveADW(db, employeeId, episodeFirstDay, monthlySalary, adwPolicy)
        adwValue = eff.adw
        adwPolicyApplied = eff.policyApplied
        adwRawValue = eff.adwRaw
        adwWarnings = eff.warnings || []
        if (adwValue <= 0) {
          throw new Error('ADW calculated as 0 or negative')
        }
      } catch (err) {
        // Fallback to statutoryDailyWage if ADW data is insufficient
        adwValue = statutoryDailyWage(monthlySalary)
        adwSource = 'fallback'
        adwWarnings = [`ADW fallback: ${err instanceof Error ? err.message : String(err)}`]
      }

      // Base pay already includes these days proportionally
      // If 4/5 ADW < what's already in base, no additional deduction needed
      // If 4/5 ADW > what's in base, we pay the full base (no extra deduction)
      // ★ 津貼用 allowanceDays（全部日），扣款用 deductDays（只數工作日）
      const sicknessAllowance = adwValue * 0.8 * allowanceDays
      const alreadyInBase = dailyDeduct * deductDays
      const deductionAmount = Math.max(0, alreadyInBase - sicknessAllowance)
      amount += deductionAmount * deductionRate
      paidAmount += alreadyInBase - deductionAmount * deductionRate    // ★ 實收

      detail.push({
        range: `${ep[0]}~${ep[ep.length - 1]}`,
        totalDays: ep.length,
        daysInMonth: allowanceDays,
        deductDays,
        rate: 0.8,
        adw: adwValue,
        adwSource,
        adwPolicyApplied,
        adwRaw: adwRawValue,
        dailyDeduct,
        sicknessAllowance,
        alreadyInBase,
        deductionAmount,
        warnings: [...adwWarnings, ..._fallbackWarning].length > 0 ? [...adwWarnings, ..._fallbackWarning] : undefined,
      })
    } else {
      // <4 連續日：EO 無疾病津貼權利 → 當無薪缺勤，只扣有排更嘅日
      amount += deductDays * dailyDeduct * deductionRate
      paidAmount += deductDays * dailyDeduct * (1 - deductionRate)

      detail.push({
        range: `${ep[0]}~${ep[ep.length - 1]}`,
        totalDays: ep.length,
        daysInMonth: allowanceDays,
        deductDays,
        rate: 0,
        dailyDeduct,
        deductionAmount: deductDays * dailyDeduct * deductionRate,
        warnings: _fallbackWarning.length > 0 ? _fallbackWarning : undefined,
      })
    }
  }
  return { amount: Math.round(amount * 100) / 100, paidAmount: Math.round(paidAmount * 100) / 100, episodes: detail }
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
  opts?: {
    storeBonuses?: Record<string, number>
    splitPays?: Record<string, number>
    attendanceBonusOverrides?: Record<string, 'FORCE_ON' | 'FORCE_OFF'>  // ★ 三態覆蓋
    excludeConfidential?: boolean // ★ 新增：非 OWNER 排除保密員工
  },
): Promise<
  | { runId: string; itemCount: number; totalPayable: number; skipped?: Array<{ employeeId: string; name: string; reason: string }>; transitionWarning?: string | null }
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

  // ★ 重新生成前先記低手動輸入嘅獎金／拆帳／勤工獎覆蓋 —— 唔記低就會被 deleteMany 一齊清走
  let run: any = existing
  const isRecalculation = !!existing
  const carried: { storeBonus: Record<string, number>; splitPay: Record<string, number>; bonusOverride: Record<string, 'FORCE_ON' | 'FORCE_OFF'> } =
    { storeBonus: {}, splitPay: {}, bonusOverride: {} }
  if (existing) {
    // CONFIRMED (FINALIZED/EXPORTED) — block recalculation
    if (existing.status === 'FINALIZED' || existing.status === 'EXPORTED') {
      return {
        error: '該月已確認出糧，需先解除確認才能重算',
        runId: existing.id,
        status: existing.status,
      }
    }
    // DRAFT — allow recalculation: save bonus/splitPay/bonusOverride then delete old items
    const oldItems = await prisma.payrollItem.findMany({
      where: { runId: existing.id },
      select: { employeeId: true, storeBonus: true, splitPay: true, attendanceBonusOverride: true },
    })
    for (const oi of oldItems) {
      if (oi.storeBonus) carried.storeBonus[oi.employeeId] = oi.storeBonus
      if (oi.splitPay != null) carried.splitPay[oi.employeeId] = oi.splitPay
      if (oi.attendanceBonusOverride) carried.bonusOverride[oi.employeeId] = oi.attendanceBonusOverride as 'FORCE_ON' | 'FORCE_OFF'
    }
    await prisma.payrollItem.deleteMany({ where: { runId: existing.id } })
  }

  // FIX: Use homeClinicId instead of EmployeeClinic to avoid multi-clinic duplicates
  // Employees with assigned clinic but no homeClinicId get a transition warning
  const where: any = {
    ...(opts?.excludeConfidential ? { payConfidential: false } : {}), // ★ 非 OWNER 排除保密員工
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

  // ★ 2026-08-02: Ensure run exists before calculation loop —
  //   calculatePayrollWithRules does 8+ queries per employee (shift, punch, leave,
  //   timebank recursion, etc.). 5 employees × 8+ queries exceeds Prisma's default
  //   5s transaction timeout. Calculation is read-only (no mutations), so it's safe
  //   to move outside transaction; transaction only handles writes.
  if (!run) {
    run = await basePrisma.payrollRun.create({
      data: { clinicId, periodMonth: monthDate, status: 'DRAFT' as RunStatus },
    })
  }

  // ★ Calculate payroll outside transaction — prevents timeout
  const { start: monthStartForRule, end: monthEndForRule } = getMonthRange(monthDate)
  const items: Array<any> = []
  const skipped: Array<{ employeeId: string; name: string; reason: string }> = []
  for (const emp of employees) {
    try {
      // Read employee pay rule — now outside transaction, uses prisma directly
      const payRule = await prisma.payRule.findFirst({
        where: {
          employeeId: emp.id,
          isActive: true,
          effectiveFrom: { lte: monthEndForRule },
          OR: [
            { effectiveTo: null },
            { effectiveTo: { gte: monthStartForRule } },
          ],
        },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      })

      let calcResult
      if (payRule?.configJson) {
        const config = JSON.parse(payRule.configJson)
        if (!config.base_type && !config.modifiers) {
          console.error(`Employee ${emp.id} still has old-format payRule! Run migrate-payrules.`)
          skipped.push({ employeeId: emp.id, name: emp.user.name, reason: '薪酬規則格式過舊，請重新設定' })
          continue
        }
        calcResult = await calculatePayrollWithRules(emp.id, monthDate, clinicId, config, {
          ...(config.base_type !== 'hourly' && (opts?.storeBonuses?.[emp.id] ?? carried.storeBonus[emp.id])
            ? { storeBonus: opts?.storeBonuses?.[emp.id] ?? carried.storeBonus[emp.id] } : {}),
          ...(config.base_type !== 'hourly' && (opts?.splitPays?.[emp.id] ?? carried.splitPay[emp.id]) != null
            ? { splitPay: opts?.splitPays?.[emp.id] ?? carried.splitPay[emp.id] } : {}),
          attendanceBonusOverride: ((opts?.attendanceBonusOverrides?.[emp.id] as 'FORCE_ON' | 'FORCE_OFF' | undefined) ?? carried.bonusOverride[emp.id]) ?? (null as 'FORCE_ON' | 'FORCE_OFF' | null | undefined),
        })
      } else {
        console.warn(`Employee ${emp.id} has no payRule, skipping`)
        skipped.push({ employeeId: emp.id, name: emp.user.name, reason: '未設定薪酬規則' })
        continue
      }

      items.push({
        employeeId: emp.id,
        workedHours: calcResult.workedHours,
        otHours: calcResult.otHours,
        leaveDays: calcResult.leaveDays,
        absentDays: calcResult.absentDays,
        basePay: calcResult.basePay,
        otPay: calcResult.otPay,
        splitPay: (opts?.splitPays?.[emp.id] ?? carried.splitPay[emp.id]) != null
          ? (opts?.splitPays?.[emp.id] ?? carried.splitPay[emp.id])
          : calcResult.splitPay,
        deduction: calcResult.deduction,
        storeBonus: opts?.storeBonuses?.[emp.id] ?? carried.storeBonus[emp.id] ?? ((calcResult.detail as any)?.storeBonus ?? 0),
        totalPayable: calcResult.totalPayable,
        miscAmount: (calcResult.detail as any)?.miscAmount ?? 0,
        miscDetailJson: (calcResult.detail as any)?.miscDetailJson ?? null,
        detailJson: JSON.stringify(calcResult.detail),
        adwUsed: (calcResult.detail as any)?.adwUsed ?? null,
        eoWage: (calcResult.detail as any)?.eoWage ?? 0,
        excludedDays: (calcResult.detail as any)?.excludedDays ?? 0,
        excludedWage: (calcResult.detail as any)?.excludedWage ?? 0,
        maternityPay: (calcResult.detail as any)?.maternityPay ?? 0,
        paternityPay: (calcResult.detail as any)?.paternityPay ?? 0,
        attendanceBonusOverride: ((opts?.attendanceBonusOverrides?.[emp.id] as 'FORCE_ON' | 'FORCE_OFF' | undefined) ?? carried.bonusOverride[emp.id]) ?? null,
      })
    } catch (err) {
      console.error(`Failed payroll for ${emp.id}:`, err)
      items.push({
        employeeId: emp.id,
        workedHours: 0, otHours: 0, leaveDays: 0, absentDays: 0,
        basePay: 0, otPay: 0, splitPay: null, deduction: 0, storeBonus: 0, totalPayable: 0,
        miscAmount: 0,
        detailJson: JSON.stringify({ error: String(err) }),
      })
    }
  }

  // ★ Transaction only handles writes — fast, won't timeout
  const result = await basePrisma.$transaction(async (tx) => {
    if (isRecalculation) {
      await tx.payrollItem.deleteMany({ where: { runId: run!.id } })
    }
    if (items.length > 0) {
      await tx.payrollItem.createMany({
        data: items.map(it => ({ ...it, runId: run!.id })),
      })
    }
    if (auditCtx?.actorId) {
      await tx.auditLog.create({
        data: {
          actorId: auditCtx.actorId,
          action: 'CREATE_PAYROLL_RUN',
          entity: 'PayrollRun',
          entityId: run!.id,
          notes: `Generated payroll for ${periodMonth}: ${items.length} employees${isRecalculation ? ' (recalculation)' : ''}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })
    }
    return run
  }, { maxWait: 10_000, timeout: 60_000 })

  const totalPayable = items.reduce((sum, item) => sum + item.totalPayable, 0)
  return { runId: run!.id, itemCount: items.length, totalPayable: Math.round(totalPayable * 100) / 100, skipped, transitionWarning }
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
  publicHolidayCount: number // ★ 2026-08-14: deduplicated (PH on rest day excluded)
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
  leaveByType: Array<{ leaveTypeName: string; days: number; dates: string[]; isPaid: boolean; systemKey: string | null }>
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
      ot_round_minutes?: number     // OT向下取整級距（0=不取整）
      early_in_min_minutes?: number // 提早上班 OT 門檻（早到未滿不計，預設 15）
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
    lunch_break?: {
      enabled?: boolean
      defaultMinutes?: number
      minMinutes?: number
    }
    birthday_leave?: {
      days_per_year: number
    }
    annual_leave?: {
      table?: number[]  // ★ 2026-08-04 自訂年假階梯
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

  // ADW salary adjustment policy
  adw_policy?: {
    /** 加薪保障：ADW 不低於「現薪 × 12 ÷ 365」。合法（優於法例），預設開 */
    floor_at_current_salary?: boolean
    /** 減薪上限：ADW 不高於「現薪 × 12 ÷ 365」。可能低於法定最低，預設關 */
    cap_at_current_salary?: boolean
  }
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
 * @param config - pay rule config for cacheKey fingerprint matching
 */
async function getCarriedFrom(
  employeeId: string,
  monthDate: Date,
  db: any,
  depth = 0,
  config: any = {},
): Promise<number> {
  if (depth >= 24) return 0

  // TZ-safe: subtract one month from monthDate using hkParts
  const { y, m } = hkParts(monthDate)
  const lastMonthM = m - 1 < 0 ? 11 : m - 1
  const lastMonthY = m - 1 < 0 ? y - 1 : y
  const lastMonth = new Date(`${String(lastMonthY).padStart(4, '0')}-${String(lastMonthM + 1).padStart(2, '0')}-01T00:00:00+08:00`)
  const { start: lStart, end: lEnd } = getMonthRange(lastMonth)

  // ① Check existing TimeBank record — validate cacheKey fingerprint
  const key = await timeBankCacheKey(db, employeeId, lEnd, lStart)
  const rec = await db.timeBank.findFirst({
    where: { employeeId, periodMonth: { gte: lStart, lte: lEnd } },
  })
  // ★ 快取指紋不夾（config 改了 或 引擎版本 bump 或 舊 row cacheKey=null）→ 當沒有快取，重新計
  if (rec && rec.cacheKey === key) return rec.balance ?? 0

  // ② No record (or stale cache): check if last month had any activity (punches OR TimeBankEntry)
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
  // ★ 2026-08-02：冇活動唔代表鏈斷 ——
  // 員工可能長期病假、產假、停薪留職，或者月頭仲未打卡。
  // 舊版直接 return 0，令累計餘額被靜靜清零。
  // 繼續往前搵，depth 上限（現有參數）防止無限遞歸。
  if (!hasActivity) {
    return getCarriedFrom(employeeId, lastMonth, db, depth + 1, config)
  }

  // ③ Has activity but no (valid) TimeBank → recursively recalculate last month (single source of truth)
  // ★ 遞歸要用同一份 config，否則過往月份的 OT 門檻／午休設定全部失效
  const tb = await calculateTimeBank(employeeId, lastMonth, config, db, depth + 1)

  // ④ Persist the backfilled record so future lookups are fast
  // ★ 六個欄全部寫齊 —— update 只寫兩欄會令 row 內部矛盾（新 balance + 舊明細）
  const cacheData = {
    balance: tb.balance,
    carriedFrom: tb.carriedFrom,
    otMinutes: tb.otMinutes,
    lateMinutes: tb.lateMinutes,
    earlyLeaveMinutes: tb.earlyLeaveMinutes,
    makeupMinutes: tb.makeupMinutes,
    cacheKey: key,
  }
  await db.timeBank.upsert({
    where: {
      employeeId_periodMonth: { employeeId, periodMonth: lStart },
    },
    update: cacheData,
    create: { employeeId, periodMonth: lStart, ...cacheData },
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
  earlyInOtMinutes: number
  otMinutesForAccount: number
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
  totalLunchDeductMinutes: number
  timeAccountDetail: Array<any>
  dailyLate: Array<{ date: string; minutes: number }>
  dailyEarly: Array<{ date: string; minutes: number }>
  // ★ 2026-08-15: 補齊三個隱形數字
  netOtThisMonth: number
  convertedMinutes: number
}> {
  // TZ-safe month range
  const { start: monthStart, end: monthEnd } = getMonthRange(monthDate)

  // Get OT minimum threshold + lunch config from payRule
  let otMinMinutes = 0
  let otRoundMinutes = 0
  let lunchEnabled = false
  let lunchDefault = 60
  let lunchMin = 30
  try {
    const rule = await db.payRule.findFirst({
      where: {
        employeeId,
        isActive: true,
        effectiveFrom: { lte: monthEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    })
    if (rule?.configJson) {
      const cfg = typeof rule.configJson === 'string' ? JSON.parse(rule.configJson) : rule.configJson
      otMinMinutes = cfg?.modifiers?.overtime?.ot_min_minutes ?? 0
      otRoundMinutes = cfg?.modifiers?.overtime?.ot_round_minutes ?? 0
      const lunch = cfg?.modifiers?.lunch_break ?? {}
      lunchEnabled = !!lunch.enabled
      lunchDefault = lunch.defaultMinutes ?? 60
      lunchMin = lunch.minMinutes ?? 30
    }
  } catch (e) {
    console.error('[payroll-engine] pay rule config 讀唔到 —— OT 門檻/rounding 已 fallback 做 0（該月計糧需人手覆核）', {
      employeeId, monthStart, error: e instanceof Error ? e.message : String(e),
    })
    otMinMinutes = 0
    otRoundMinutes = 0
  }

  // Previous month carry — recursive backfill (pass depth to prevent infinite recursion)
  // ★ 傳同一份 config，否則過往月份的 OT 門檻／午休設定全部失效
  const carriedFrom = await getCarriedFrom(employeeId, monthDate, db, depth, config)

  // Grab ALL effective punches (CLOCK_IN + CLOCK_OUT) with corrections applied
  const effectivePunches = await getEffectivePunches(monthStart, monthEnd, { employeeId, db })

  const shifts = await db.shift.findMany({
    where: {
      employeeId,
      date: { gte: monthStart, lte: monthEnd },
      status: { not: 'CANCELLED' },
    },
    orderBy: { date: 'asc' },
    include: { template: { select: { deductLunch: true } } }, // ★ 2026-08-07
  })

  // Compare each shift day against effective punches
  let otMinutes = 0
  let lateMinutes = 0
  let earlyLeaveMinutes = 0
  let totalLunchDeductMinutes = 0 // ★ Accumulate lunch deduction across all shift days

  // ★ Time account detail: per-day breakdown
  const timeAccountDetail: Array<any> = []

  // ★ QA24: dailyLate / dailyEarly for attendance bonus — single source of truth
  const dailyLate: Array<{ date: string; minutes: number }> = []
  const dailyEarly: Array<{ date: string; minutes: number }> = []

  // ★ 調鋪支援：同日可以有多張不同店嘅更。
  // 預先按日期分組並按開工時間排序，用嚟判斷「當日有冇下一張更」。
  const shiftsByDate = new Map<string, any[]>()
  for (const s of shifts) {
    const ds = toHKDateStr(new Date(s.date))
    if (!shiftsByDate.has(ds)) shiftsByDate.set(ds, [])
    shiftsByDate.get(ds)!.push(s)
  }
  for (const arr of shiftsByDate.values()) {
    arr.sort((a: any, b: any) =>
      new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
  }
  const lunchDeductedDates = new Set<string>() // ★ 一日只扣一次午飯，唔理當日有幾多張更

  // ★ Pairing logic extracted to lib/shift-punch-match.ts — single source of truth
  const matched = matchPunchesToShifts(shifts, effectivePunches as any)
  const matchByShift = new Map(matched.map((m: any) => [m.shiftId, m]))

  for (const shift of shifts) {
    const m = matchByShift.get(shift.id)
    if (!m) continue

    const shiftDateStr = m.date
    const sameDayShifts = shiftsByDate.get(shiftDateStr) ?? []
    const hasLaterShiftToday = sameDayShifts.some(
      (s: any) =>
        s.id !== shift.id &&
        new Date(s.startTime).getTime() > new Date(shift.startTime).getTime(),
    )

    let dayLate = m.lateMinutes
    let dayEarly = m.earlyMinutes
    let dayClockOutOt = m.otMinutes
    let dayLunchOt = 0
    let dayLunchLate = 0

    // ★ OT threshold + rounding — timebank-specific logic (needs pay rule config)
    if (m.hasClockOut && !hasLaterShiftToday && dayClockOutOt > 0) {
      if (dayClockOutOt >= otMinMinutes) {
        dayClockOutOt = otRoundMinutes > 0
          ? Math.floor(dayClockOutOt / otRoundMinutes) * otRoundMinutes
          : dayClockOutOt
      } else {
        dayClockOutOt = 0
      }
    } else if (!m.hasClockOut || hasLaterShiftToday) {
      dayClockOutOt = 0
    }

    // ★ 2026-08-09: 孖更邏輯保留（engine 支援一日多更、只扣一次午飯），
    // 但 UI 已封晒入口（collision_check 只准取代，唔准加多一張）。
    // 如果日後要重開孖更，改 createShift 個 onConflict 分支，唔使郁呢度。

    // ★ 午休扣減（地基：有上班嘅日子一律扣 lunchDefault）
    // 決定 1 相關：同日多張更只扣一次，唔可以每張更加一次
    // ★ 2026-08-07: deductLunch gate — 當日全部更次 deductLunch=false 先跳；有任何一張要扣（或冇 template）→ 照扣
    const dayDeductsLunch = sameDayShifts.length === 0 ||
      sameDayShifts.some((s: any) => s.template?.deductLunch !== false)
    if (m.hasClockIn && dayDeductsLunch && !lunchDeductedDates.has(shiftDateStr)) {
      // ★ 決定 3：同日多張更之間嘅空檔本身已經係無薪休息
      //   （工時按每張更分段計，空檔唔入數），唔應該再扣多次午飯。
      //   規則：全日無薪空檔總和唔夠 lunchDefault 先補扣差額。
      let gapMinutes = 0
      for (let i = 0; i < sameDayShifts.length - 1; i++) {
        const g = (new Date(sameDayShifts[i + 1].startTime).getTime()
                 - new Date(sameDayShifts[i].endTime).getTime()) / 60000
        if (g > 0) gapMinutes += g
      }
      let lunchDeduct = Math.max(0, lunchDefault - gapMinutes)

      if (lunchEnabled) {
        // ★ 午休卡【唔按店 filter】—— 調鋪時可能喺 A 店碌午休開始、B 店碌午休結束
        const dayAllPunches = effectivePunches.filter(
          (ep: any) => toHKDateStr(ep.effectiveTime) === shiftDateStr,
        )
        const ls = dayAllPunches
          .filter((p: any) => p.punchType === 'LUNCH_START')
          .sort((a: any, b: any) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
        const le = dayAllPunches
          .filter((p: any) => p.punchType === 'LUNCH_END')
          .sort((a: any, b: any) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]

        if (ls && le && le.effectiveTime.getTime() > ls.effectiveTime.getTime()) {
          // ★ 決定 4：夠足 1 分鐘先計（原本係 Math.round）
          const actual = Math.floor(
            (le.effectiveTime.getTime() - ls.effectiveTime.getTime()) / 60000)
          const effective = Math.max(actual, lunchMin)
          lunchDeduct = effective
          if (effective < lunchDefault) {
            dayLunchOt = lunchDefault - effective
          } else if (effective > lunchDefault) {
            dayLunchLate = effective - lunchDefault
          }
        }
      }

      totalLunchDeductMinutes += lunchDeduct
      lunchDeductedDates.add(shiftDateStr)
    }

    // ★ Push daily detail
    const dayEntry: any = { date: shiftDateStr }
    if (dayLate > 0) dayEntry.lateMinutes = dayLate
    if (dayEarly > 0) dayEntry.earlyMinutes = dayEarly
    if (dayClockOutOt > 0) dayEntry.clockOutOt = dayClockOutOt
    if (dayLunchOt > 0) dayEntry.lunchOt = dayLunchOt
    if (dayLunchLate > 0) dayEntry.lunchLate = dayLunchLate
    if (Object.keys(dayEntry).length > 1) timeAccountDetail.push(dayEntry)

    // ★ QA24: push dailyLate / dailyEarly (includes lunchLate for late)
    if (dayLate + dayLunchLate > 0) dailyLate.push({ date: shiftDateStr, minutes: dayLate + dayLunchLate })
    if (dayEarly > 0) dailyEarly.push({ date: shiftDateStr, minutes: dayEarly })

    // ★ Accumulate monthly totals
    lateMinutes += dayLate
    earlyLeaveMinutes += dayEarly
    otMinutes += dayClockOutOt + dayLunchOt
    lateMinutes += dayLunchLate
  }

  // ★ 2026-08-06 假期返工 OT：
  //   當日 ∈ APPROVED 假期（leaveCoversDate — HK 日期口徑）
  //   && 該日 punch pair 完整（isPartial=false）
  //   && 冇 shift（shift↔leave mutex 保證，判定簡單）
  //   → dayOt += pair 時長（分鐘）
  //   單腳：唔計 OT（維持 isPartial 現有處理，唔當缺勤 — 假期日本身唔會標缺勤）
  try {
    const leaveRecords = await db.leaveRequest.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        startDate: { lte: monthEnd },
        endDate: { gte: monthStart },
      },
    })
    const shiftDates = new Set(shiftsByDate.keys())
    // Group effective punches by HK date
    const epByDate = new Map<string, any[]>()
    for (const ep of effectivePunches) {
      if (ep.punchType !== 'CLOCK_IN' && ep.punchType !== 'CLOCK_OUT') continue
      const d = toHKDateStr(ep.effectiveTime)
      if (!epByDate.has(d)) epByDate.set(d, [])
      epByDate.get(d)!.push(ep)
    }
    for (const [dateStr, dayPunches] of epByDate) {
      if (shiftDates.has(dateStr)) continue // skip days with shifts
      const hasLeave = leaveRecords.some((lr: any) => leaveCoversDate(lr, dateStr))
      if (!hasLeave) continue
      const hasIn = dayPunches.some((p: any) => p.punchType === 'CLOCK_IN')
      const hasOut = dayPunches.some((p: any) => p.punchType === 'CLOCK_OUT')
      if (!hasIn || !hasOut) continue // single punch → no OT
      const firstIn = dayPunches.filter((p: any) => p.punchType === 'CLOCK_IN')
        .sort((a: any, b: any) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
      const lastOut = dayPunches.filter((p: any) => p.punchType === 'CLOCK_OUT')
        .sort((a: any, b: any) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]
      let pairMins = Math.floor((lastOut.effectiveTime.getTime() - firstIn.effectiveTime.getTime()) / 60000)
      if (pairMins <= 0) continue
      // Apply ot_min_minutes / ot_round_minutes (same as shift-based OT)
      if (pairMins >= otMinMinutes) {
        pairMins = otRoundMinutes > 0 ? Math.floor(pairMins / otRoundMinutes) * otRoundMinutes : pairMins
      } else {
        pairMins = 0
      }
      otMinutes += pairMins
    }
  } catch (e) { console.error('payroll calc error:', e) /* leave table may not exist */ }

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
  } catch (e) {
    console.error('[payroll-engine] makeup entries read failed, treated as 0', { employeeId, error: e })
  }

  // ★ 2026-08-08: 新增 — 本月已批准嘅早到 OT（獨立欄位，★唔入 ADJUST_TYPES）
  let earlyInOtMinutes = 0
  try {
    const earlyInRows = await db.timeBankEntry?.findMany?.({
      where: { employeeId, type: 'EARLY_IN_OT', date: { gte: monthStart, lte: monthEnd } },
    })
    earlyInOtMinutes = (earlyInRows || []).reduce((s: number, e: any) => s + e.minutes, 0)
  } catch (e) {
    if (!earlyInOtWarnedSet.has(employeeId)) { earlyInOtWarnedSet.add(employeeId); console.error('[payroll-engine] EARLY_IN_OT read failed', { employeeId, error: e }) }
  }

  // 抓換假消耗（LEAVE_CONVERT 負消耗OT，LEAVE_SWAP_BACK 正換回OT，INIT_ADJUST/REST_TO_ACCOUNT 為帳戶調整）
  let convertedMinutes = 0
  try {
    // ★ 2026-08-08: EARLY_IN_OT 唔入 ADJUST_TYPES（物理隔離，唔好同錢線撞）
    // ★ ROSTER_DIFF：編更差額，計糧生成時寫入、退回時刪除
    const ADJUST_TYPES = ['LEAVE_CONVERT', 'LEAVE_SWAP_BACK', 'INIT_ADJUST', 'REST_TO_ACCOUNT', 'ROSTER_DIFF']
    const convertEntries = await db.timeBankEntry?.findMany?.({
      where: { employeeId, type: { in: ADJUST_TYPES }, date: { gte: monthStart, lte: monthEnd } },
    })
    convertedMinutes = convertEntries?.reduce((s: number, e: any) => s + e.minutes, 0) || 0
  } catch (e) {
    console.error('[payroll-engine] leave convert entries read failed, treated as 0', { employeeId, error: e })
  }

  // 各扣各的：netLate = late - makeupLate, netEarly = earlyLeave - makeupEarly
  const netLateMinutes = Math.max(0, lateMinutes - makeupLateMinutes)
  const netEarlyMinutes = Math.max(0, earlyLeaveMinutes - makeupEarlyMinutes)
  const netDeficitMinutes = netLateMinutes + netEarlyMinutes

  // ★ 2026-08-08: 淨值改用「鐘口徑」—— ot + earlyIn 合併後先扣消耗
  const otMinutesForAccount = otMinutes + earlyInOtMinutes // 鐘口徑
  const netOtThisMonth = otMinutesForAccount - makeupMinutes - netDeficitMinutes

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
    otMinutes, earlyInOtMinutes, otMinutesForAccount,
    lateMinutes, netLateMinutes, netEarlyMinutes, earlyLeaveMinutes, makeupMinutes,
    makeupAbsentMinutes,
    netDeficitMinutes,
    carriedFrom,
    timeAccountMinutes: balance,
    balance,
    owedMinutes,
    availableMinutes,
    convertibleLeaveDays,
    note,
    totalLunchDeductMinutes,
    timeAccountDetail,
    dailyLate,
    dailyEarly,
    // ★ 2026-08-15: 補齊三個隱形數字，令時間帳戶「加得埋」
    netOtThisMonth,
    convertedMinutes,
  }
}

// ------------------------------------------------------------------
// 2c. Working Days with Custom Rest Days + Public Holidays
// ------------------------------------------------------------------

/**
 * @deprecated ⛔ 2026-08-02: 硬編碼清單 2026 年有 13 處錯誤。
 * 公眾假期一律由 HKPublicHoliday 表提供（scripts/import-hk-holidays.mjs 匯入官方 iCal）。
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
 * @deprecated 已被 calculatePayrollWithRules 内的 restDayCfg override 取代（:2825）。
 * 保留作参考，唔好新增 caller。
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
 * ★ 2026-08-02: publicHolidaySet 由 HKPublicHoliday 表提供，同 monthlyWorkingDays 用同一來源。
 */
export function countMonthlyLeaveDays(
  year: number,
  month: number, // 0-indexed
  restDays: number[] = [],
  publicHolidaySet?: Set<string>, // ★ 由呼叫者傳入（已由 DB 讀好）
): { restDayCount: number; publicHolidayCount: number; total: number; workingDays: number } {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  let restDayCount = 0, publicHolidayCount = 0

  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(Date.UTC(year, month, d)).getUTCDay()
    const isRest = restDays.includes(dow)
    const isPH = !!publicHolidaySet?.has(toHKDateStr(new Date(Date.UTC(year, month, d))))

    // ★ 2026-08-14: 公眾假期落喺休息日 → 唔再雙重計
    if (isRest) { restDayCount++; continue }
    if (isPH) publicHolidayCount++
  }

  const total = restDayCount + publicHolidayCount
  // ★ workingDays 由同一次迴圈導出 —— 唔好喺 caller 度自己減，會再分家
  return { restDayCount, publicHolidayCount, total, workingDays: daysInMonth - total }
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
        earlyLeaveMinutes: 0,
        makeupMinutes: 0,
        balance: 0,
        carriedFrom: 0,
        cacheKey: await timeBankCacheKey(db, employeeId, periodMonth, periodMonth),
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
  data: {
    otMinutes?: number
    lateMinutes?: number
    earlyLeaveMinutes?: number
    makeupMinutes?: number
    carriedFrom?: number
    balance?: number
    cacheKey?: string
    monthEndNote?: string
  },
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
 * TimeBank 快取寫入 —— 全系統唯一入口。
 *
 * ★ 唔提供 balanceOverride —— balance 必須同 tb 嘅明細一致。
 *   容許 override 就會出現「override 嘅 balance + tb 嘅明細」，
 *   由 row 推唔返個數（2026-08-01 就係咁漏咗 convertedMinutes）。
 *   要改 balance 就改 calculateTimeBank 嘅公式，唔好喺呼叫端補。
 */
export async function persistTimeBank(
  db: any,
  employeeId: string,
  periodMonth: Date,
  tb: any,
): Promise<void> {
  const { start, end } = getMonthRange(periodMonth)
  const cacheData = {
    balance: tb.balance, // ★ 唯一來源
    carriedFrom: tb.carriedFrom,
    otMinutes: tb.otMinutes,
    lateMinutes: tb.lateMinutes,
    earlyLeaveMinutes: tb.earlyLeaveMinutes,
    makeupMinutes: tb.makeupMinutes,
    cacheKey: await timeBankCacheKey(db, employeeId, end, start),
  }
  await db.timeBank.upsert({
    where: { employeeId_periodMonth: { employeeId, periodMonth: start } },
    update: cacheData,
    create: { employeeId, periodMonth: start, ...cacheData },
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

  const restDayType = await getLeaveTypeBySystemKey(db, QUOTA_LEAVE_KEYS[0])
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
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  })

  // Punch days (pass shifts for single-punch fill)
  // ★ null = do NOT filter by clinic; count ALL punches for this employee across all clinics
  const allPunchDays = await calculateWorkedHours(
    employeeId,
    null, // ★ cross-clinic: punches follow the employee, not the payroll-run clinic
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

  // ★ 2026-08-02: 有薪假期日數按日去重 —— 病假同休息日都係 isPaid，
  //   重疊日計兩次會令 unpaidLeaveDays 變負。
  const paidDates = new Set<string>()
  for (const lt of leaveByType) {
    if (lt.isPaid) lt.dates.forEach(d => paidDates.add(d))
  }
  const paidLeaveDays = paidDates.size

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
  const publicHolidaySet = new Set(publicHolidays.map(d => toHKDateStr(d))) // ★ 2026-08-02
  const publicHolidayDays = publicHolidays.length

  // ★ 2026-08-02: 空表保護
  const ymKey = toHKDateStr(monthDate).slice(0, 7)
  if (publicHolidays.length === 0) {
    const anyHoliday = await prisma.hKPublicHoliday.count()
    if (anyHoliday === 0) {
      console.error(`[payroll] ⛔ HKPublicHoliday 表完全空 —— ${ymKey} 工作日數會算錯！請跑 scripts/import-hk-holidays.mjs`)
    } else {
      console.log(`[payroll] ${ymKey} 冇公眾假期（正常）`)
    }
  }

  // ★ 2026-08-14: countMonthlyLeaveDays 已去重 Sat/Sun 公眾假期，
  //   取代手動 countRestDaysInMonth + 減 publicHolidayDays（會雙重計）
  const monthlyLeaveDaysInfo = countMonthlyLeaveDays(year, month, [6, 0], publicHolidaySet)
  const restDays = monthlyLeaveDaysInfo.restDayCount
  const monthlyWorkingDays = monthlyLeaveDaysInfo.workingDays
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
  } catch (e) {
    console.error('[payroll-engine] timebankEntry makeup detail read failed', { employeeId, error: e })
  }

  // 用 getEffectivePunches（作廢排除+修正套用）
  const effPunches = await getEffectivePunches(monthStart, monthEnd, { employeeId, db: prisma })

  const lateRecords: Array<{ date: string; minutes: number }> = []
  const earlyLeaveRecords: Array<{ date: string; minutes: number }> = []

  // ★ QA24: 同 calculateTimeBank 一致：按 clinicId（含 secondaryClinicId）過濾，
  //   同店分更按時間窗切，Math.floor 取整。
  // 預先按日期分組並按開工時間排序
  const shiftsByDate = new Map<string, any[]>()
  for (const s of shifts) {
    const ds = toHKDateStr(new Date(s.date))
    if (!shiftsByDate.has(ds)) shiftsByDate.set(ds, [])
    shiftsByDate.get(ds)!.push(s)
  }
  for (const arr of shiftsByDate.values()) {
    arr.sort((a: any, b: any) =>
      new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
  }

  for (const shift of shifts) {
    const shiftDateStr = toHKDateStr(new Date(shift.date))
    const sameDayShifts = shiftsByDate.get(shiftDateStr) ?? []
    const idx = sameDayShifts.findIndex((s: any) => s.id === shift.id)
    const prevShift = idx > 0 ? sameDayShifts[idx - 1] : null
    const nextShift = idx >= 0 && idx < sameDayShifts.length - 1 ? sameDayShifts[idx + 1] : null
    const winStart = prevShift
      ? (new Date(prevShift.endTime).getTime() + new Date(shift.startTime).getTime()) / 2
      : -Infinity
    const winEnd = nextShift
      ? (new Date(shift.endTime).getTime() + new Date(nextShift.startTime).getTime()) / 2
      : Infinity
    const needTimeWindow =
      sameDayShifts.filter((s: any) =>
        s.clinicId === shift.clinicId ||
        s.clinicId === shift.secondaryClinicId ||
        s.secondaryClinicId === shift.clinicId
      ).length > 1

    const dayPunches = effPunches.filter((p: any) => {
      if (toHKDateStr(p.effectiveTime) !== shiftDateStr) return false
      // ★ 調鋪方案 1：punch 可以碌喺主店或調鋪店
      if (p.clinicId !== shift.clinicId && p.clinicId !== shift.secondaryClinicId) return false
      if (!needTimeWindow) return true
      const t = p.effectiveTime.getTime()
      return t >= winStart && t < winEnd
    })

    // 遲到：明確取「最早的上班卡」
    const clockIn = dayPunches
      .filter(p => p.punchType === 'CLOCK_IN')
      .sort((a, b) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
    const shiftStart = new Date(shift.startTime)
    if (clockIn && clockIn.effectiveTime.getTime() > shiftStart.getTime()) {
      if (!makeupLateDates.has(shiftDateStr)) {
        lateRecords.push({
          date: shiftDateStr,
          // ★ QA24: 截秒後相減（diffMinutes，2026-08-15 B2）
          minutes: diffMinutes(clockIn.effectiveTime, shiftStart),
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
        // ★ QA24: 截秒後相減（diffMinutes，2026-08-15 B2）
        const minutes = -diffMinutes(clockOut.effectiveTime, shiftEnd)
        if (minutes > 0) {
          earlyLeaveRecords.push({ date: shiftDateStr, minutes })
        }
      }
    }
  }

  // Consultation fees (for split pay)
  const consultationFees = await getConsultationRevenue(employeeId, clinicId, monthDate)

  // ★ QA24: scheduledDays = day count (Set size), not shift count
  //   分更／調鋪日：應出勤 1 日（唔係 N 張更）
  // ★ QA30: 明確 Set<string> —— 唔標嘅話 shifts.map 會推斷成 unknown[]，
  //   令下面 leaveCoversDate() / leaveDateSet.add() 報 TS2345
  const scheduledDateSet = new Set<string>(shifts.map(s => formatDate(new Date(s.date))))
  const scheduledDays = scheduledDateSet.size

  // ★ QA24: punchByDateClinic = 「日期:clinicId」set
  //   調鋪日 A 店返咗、B 店冇去 → B 店缺勤計入
  //   分更日朝更返咗、晚更缺席 → 晚更缺勤計入
  const punchByDateClinic = new Set<string>()
  for (const pd of allPunchDays) {
    if (pd.hours > 0 || pd.isPartial) punchByDateClinic.add(`${pd.date}:${pd.clinicId}`)
  }

  // ★ QA24: leaveDateSet 使用 leaveCoversDate 確保跨表日期比較正確
  const leaveDateSet = new Set<string>()
  for (const dateStr of scheduledDateSet) {
    const hasLeave = leaveRecords.some((lr: any) => leaveCoversDate(lr, dateStr))
    if (hasLeave) leaveDateSet.add(dateStr)
  }

  // ★ QA24: absentDays 按「日期 + clinicId」判斷
  // ★ 未收工嘅更次唔可以當缺勤 —— 月中 preview 時，
  //   未到嘅日子會被當缺勤扣薪。
  //   用 endTime 唔用 date：今日已收工嘅早更應該計，未收工嘅唔計。
  //
  //   ⚠️ 陷阱：8/31 23:00 跑 8 月計糧，當日晚更（22:00-02:00）仲未收工
  //   → 唔算缺勤。要 9/1 之後重跑先完整。preflight 會警告（見改動 7）。
  const nowTs = Date.now()

  let absentDays = 0
  const otDeductedAbsences: Array<{ date: string; minutes: number }> = []
  for (const shift of shifts) {
    const shiftEndTs = new Date(shift.endTime).getTime()
    if (shiftEndTs > nowTs) continue // ★ 未收工，跳過

    const shiftDateStr = formatDate(new Date(shift.date))
    const hasPunch =
      punchByDateClinic.has(`${shiftDateStr}:${shift.clinicId}`) ||
      (shift.secondaryClinicId && punchByDateClinic.has(`${shiftDateStr}:${shift.secondaryClinicId}`))
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
    publicHolidayCount: monthlyLeaveDaysInfo.publicHolidayCount,
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
    leaveByType,
  }
}

// ------------------------------------------------------------------
// 3. Base Module Calculators
// ------------------------------------------------------------------

function calcMonthlyBase(config: PayRuleConfigModular, workData: WorkData, monthDate: Date, employeeId?: string): PayrollResult {
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
  // ★ 扣薪用當月曆日數，唔用 statutoryDailyWage（月薪×12÷365 屬法定權益公式）
  const dailyRate = deductionDailyRate(monthlySalary, monthDate, (config as any).deduction_basis ?? 'workday', workData.monthlyWorkingDays)
  const deduction = (absentDays + unpaidLeaveDays) * dailyRate * deductionRate

  const otHours = otThreshold > 0 ? Math.max(0, workData.totalWorkedHours - otThreshold) : 0
  const hourlyEquivalent = otThreshold > 0 ? monthlySalary / otThreshold : 0
  const otPay = otHours * hourlyEquivalent * otMultiplier

  // ★ 恆等式自檢 —— 曆日 = 工作日 + 休息日 + 公眾假期
  //   ⚠️ 唔好放入 detail —— detail 會存入 detailJson，debug flag 唔應該入業務資料
  // ★ 2026-08-14: identity assertion 改用 deduplicated PH count
  assertMonthlyIdentity(monthDate, workData.monthlyWorkingDays, workData.restDays, workData.publicHolidayCount, employeeId);

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
      // ★ 2026-08-02: 薪資單顯示分母
      monthlyWorkingDays: workData.monthlyWorkingDays,
      // ★ 用真值唔好反推 —— 反推令恆等式永遠成立，等於掩蓋問題。
      //   workData.restDays 已經喺 runPayroll 按 config rest_days override，係可靠嘅。
      //   之前顯示 0 係前端 fallback 欄名唔夾，唔係呢個值有問題。
      restDaysInMonth: workData.restDays,
      calendarDays: hkDaysInMonth(monthDate), // ★ 用 hkDaysInMonth 代替 workData.totalDaysInMonth（undefined 會顯示 0）
    },
  };
}

// ★ 恆等式自檢 —— 曆日 = 工作日 + 休息日 + 公眾假期
//   ⚠️ 唔好放入 detail —— detail 會存入 detailJson，debug flag 唔應該入業務資料
function assertMonthlyIdentity(monthDate: Date, monthlyWorkingDays: number, restDays: number, publicHolidayDays: number, employeeId?: string): void {
  const _cal = hkDaysInMonth(monthDate)
  const _sum = monthlyWorkingDays + restDays + publicHolidayDays
  if (_cal !== _sum) {
    console.error(
      `[payroll] ⛔ 恆等式唔成立 employeeId=${employeeId || '?'} ${toHKDateStr(monthDate).slice(0, 7)}：` +
      `${_cal} ≠ ${monthlyWorkingDays}(工作) + ${restDays}(休息) + ${publicHolidayDays}(公眾假期)`
    )
  }
}

/**
 * Run the selected base module (monthly/hourly/daily/split).
 */
export function runBaseModule(config: PayRuleConfigModular, workData: WorkData, monthDate: Date, employeeId?: string): PayrollResult {
  const baseType = config.base_type || 'monthly'
  switch (baseType) {
    case 'monthly': return calcMonthlyBase(config, workData, monthDate, employeeId)
    case 'hourly': return calcHourlyBase(config, workData)
    case 'daily': return calcDailyBase(config, workData)
    case 'split': return calcSplitBase(config, workData, monthDate)
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

function calcSplitBase(config: PayRuleConfigModular, workData: WorkData, monthDate: Date): PayrollResult {
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
    const dailyRate = deductionDailyRate(basePay, monthDate, (config as any).deduction_basis ?? 'workday', workData.monthlyWorkingDays)
    deduction = absentDays * dailyRate * deductionRate
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

// ------------------------------------------------------------------
// 3. Modifier Application
// ------------------------------------------------------------------

async function applyAttendanceBonusModifier(
  modConfig: { amount: number; cancel_if: { late_minutes_exceed?: number; late_is_cumulative?: boolean; any_unplanned_leave?: boolean; any_absence?: boolean } },
  result: PayrollResult,
  workData: WorkData,
  employeeId: string,
  monthDate: Date,
  config: PayRuleConfigModular,
  attendanceBonusOverride?: 'FORCE_ON' | 'FORCE_OFF' | null,  // ★ 三態覆蓋
): Promise<PayrollResult> {

  // ★ QA24: 勤工獎必須用 calculateTimeBank 的遲到/早退結果
  //   collectWorkData 的 lateRecords/earlyLeaveRecords 已修正 clinic 過濾，
  //   但 calculateTimeBank 是唯一經過調鋪/分更/floor/補鐘修正的單一事實來源。
  //   dailyLate/dailyEarly 支持 late_is_cumulative 兩種模式（累計 sum / 單次 max）。
  const tbConfig = { negative_carry: (config as any)?.negative_carry ?? 'reset' }
  const tb = await calculateTimeBank(employeeId, monthDate, tbConfig, prisma)

  const bonus = evaluateAttendanceBonus(modConfig, {
    lateRecords: tb.dailyLate.map(r => ({ minutes: r.minutes })),
    earlyRecords: tb.dailyEarly.map(r => ({ minutes: r.minutes })),
    leaveRecords: workData.leaveRecords,
    absentDays: workData.absentDays,
  })

  // ★ 人手覆蓋（合約第 8 條：病假有醫生紙唔扣勤工、冇紙就扣）
  //   三態：null = 自動；FORCE_ON = 強制發放；FORCE_OFF = 強制取消
  let finalBonus = bonus.amount
  let bonusCancelled = bonus.cancelled
  let bonusReason = bonus.reason

  if (attendanceBonusOverride === 'FORCE_OFF') {
    finalBonus = 0
    bonusCancelled = true
    bonusReason = '人手取消'
  } else if (attendanceBonusOverride === 'FORCE_ON') {
    finalBonus = modConfig?.amount ?? 0
    bonusCancelled = false
    bonusReason = '人手發放'
  }

  const next = { ...result }
  next.attendanceBonus = finalBonus
  next.attendanceBonusCancelled = bonusCancelled
  next.attendanceBonusReason = bonusReason
  const rawTotal = result.basePay - result.deduction + result.otPay + (result.splitPay || 0) + finalBonus
  next.totalPayable = Math.max(0, rawTotal)
  next.detail = { ...result.detail, attendanceBonus: finalBonus, attendanceBonusCancelled: bonusCancelled, attendanceBonusReason: bonusReason, rawTotal: Math.round(rawTotal * 100) / 100 }
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
  clinicId: string | null, // ★ 刻意唔用：時薪跨店合計（打卡跟人唔跟店），分單靠 generatePayrollRun 嘅 homeClinicId
  config: PayRuleConfigModular
): Promise<PayrollResult> {
  const rate = config.hourly_rate || 0
  // ★ 決定 2：時薪員工同月薪一致，每個有上班卡嘅日子扣午飯
  // 唔想扣嘅規則喺 UI 把 defaultMinutes 設做 0
  const lunch = (config as any)?.modifiers?.lunch_break ?? {}
  const lunchEnabled = !!lunch.enabled
  const lunchDefault = lunch.defaultMinutes ?? 60
  const lunchMin = lunch.minMinutes ?? 30
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
    const noShift = !shift
    // ★ 決定 3（2026-07-25）：調鋪途中嘅交通時間算工時，
    // 所以刻意用「全日第一個 IN → 最後一個 OUT」嘅跨度，唔逐段配對。
    const clockIn = dayPunches.filter((ep: any) => ep.punchType === 'CLOCK_IN')[0]
    const clockOut = dayPunches.filter((ep: any) => ep.punchType === 'CLOCK_OUT').slice(-1)[0]

    if (!clockIn) {
      days.push({ date: dateStr, note: '冇上班卡，不計薪', minutes: 0, amount: 0 })
      continue
    }
    // ★ 2026-08-10: 缺下班卡 → 用更次收工時間補（同月薪 :2244 一致）
    // 冇更次就冇得補，維持不計薪
    let outTime = clockOut?.effectiveTime ?? null
    let filledFromShift = false
    if (!outTime && shift) {
      outTime = new Date(shift.endTime)
      filledFromShift = true
    }
    if (!outTime) {
      days.push({ date: dateStr, note: '缺下班卡且冇更次，不計薪', minutes: 0, amount: 0 })
      continue
    }

    // ★ Core: effective start = max(clockIn, shiftStart) — early punch not counted
    const shiftStart = shift ? new Date(shift.startTime).getTime() : null
    const effStart = shiftStart
      ? Math.max(clockIn.effectiveTime.getTime(), shiftStart)
      : clockIn.effectiveTime.getTime()
    const spanMinutes = Math.max(0, Math.floor((outTime.getTime() - effStart) / 60000))

    // ★ 午飯扣減（決定 2）。決定 3：調鋪途中嘅交通時間照計錢，
    // 所以維持「第一個 IN 到最後一個 OUT」嘅跨度，只扣午飯。
    let lunchDeduct = lunchDefault
    let lunchOtMinutes = 0
    let lunchLateMinutes = 0
    if (lunchEnabled) {
      const ls = dayPunches
        .filter((p: any) => p.punchType === 'LUNCH_START')
        .sort((a: any, b: any) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
      const le = dayPunches
        .filter((p: any) => p.punchType === 'LUNCH_END')
        .sort((a: any, b: any) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]
      if (ls && le && le.effectiveTime.getTime() > ls.effectiveTime.getTime()) {
        const actual = Math.floor((le.effectiveTime.getTime() - ls.effectiveTime.getTime()) / 60000)
        const effective = Math.max(actual, lunchMin) // ★ floor 保留
        lunchDeduct = effective
        if (effective < lunchDefault) lunchOtMinutes = lunchDefault - effective
        else if (effective > lunchDefault) lunchLateMinutes = effective - lunchDefault
      }
    }

    const minutes = Math.max(0, spanMinutes - lunchDeduct)
    const amount = Math.round(minutes * rate / 60 * 100) / 100

    totalMinutes += minutes
    totalPay += amount

    days.push({
      date: dateStr,
      in: clockIn.effectiveTime,
      out: outTime,
      shiftStart: shift?.startTime ?? null,
      clamped: shiftStart != null && clockIn.effectiveTime.getTime() < shiftStart,
      spanMinutes,
      lunchDeduct,
      minutes,
      amount,
      ...(filledFromShift ? { filledFromShift: true, warning: '缺下班卡，按更次收工時間計' } : {}),
      ...(lunchOtMinutes > 0 ? { lunchOt: lunchOtMinutes } : {}),
      ...(lunchLateMinutes > 0 ? { lunchLate: lunchLateMinutes } : {}),
      ...(noShift ? { noShift: true, warning: '冇排更次，全日打卡照計薪' } : {}),
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
  options?: { storeBonus?: number; splitPay?: number; attendanceBonusOverride?: 'FORCE_ON' | 'FORCE_OFF' | null } // 店舖獎金 + 手動拆帳 + 勤工獎覆蓋
): Promise<PayrollResult> {
  // ★ Part-time hourly: bypass all modifier logic entirely
  if (config.base_type === 'hourly') {
    return calculateSimpleHourlyPay(employeeId, monthDate, clinicId, config)
  }

  const { y: year, m: month } = hkParts(monthDate)
  const { start: monthStart, end: monthEnd } = getMonthRange(monthDate)

  // 1. Collect work data
  const workData = await collectWorkData(employeeId, monthDate, clinicId)

  // ★ QA24: restDays from config, not hardcoded [6,0]
  //   collectWorkData uses [6,0] as default; override here with actual config
  const restDayCfg = (config as any)?.modifiers?.rest_days?.days
    ?? (config as any)?.rest_days
    ?? [6, 0]
  // ★ 2026-08-14: 改用 countMonthlyLeaveDays（PH 去重 Sat/Sun），同 Caller A 一致
  const _phCallerB = await getPublicHolidayDays(monthStart, monthEnd)
  const _phSetCallerB = new Set(_phCallerB.map(d => toHKDateStr(d)))
  const leaveInfo = countMonthlyLeaveDays(year, month, restDayCfg, _phSetCallerB)
  const actualRestDays = leaveInfo.restDayCount
  workData.monthlyWorkingDays = leaveInfo.workingDays
  // ★ workData.workingDays 維持 — 佢係「曆日 − 休息日」，特登唔減公眾假期
  workData.workingDays = hkDaysInMonth(monthDate) - actualRestDays
  workData.restDays = actualRestDays
  workData.publicHolidayCount = leaveInfo.publicHolidayCount

  // 2. Run base module
  const baseResult = runBaseModule(config, workData, monthDate, employeeId)

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
    result = await applyAttendanceBonusModifier(mods.attendance_bonus, result, workData, employeeId, monthDate, config, options?.attendanceBonusOverride)
  }
  if (mods.overtime) {
    result = applyOvertimeModifier(mods.overtime, result, workData)
  }
  // ★ allowances 可能被寫成 {} —— config 由人手／舊版 UI 寫入，
  //   `mods.allowances || []` 對 {} 無效（{} 係 truthy），
  //   之後 .reduce() 就會爆（2026-08-03 Kathy 撞到）。
  const allowances = Array.isArray(mods.allowances) ? mods.allowances : []
  if (mods.allowances && !Array.isArray(mods.allowances)) {
    console.warn(
      `[payroll] employeeId=${employeeId} allowances 唔係陣列（${typeof mods.allowances}），已忽略`,
    )
  }
  if (allowances.length > 0) {
    result = applyAllowancesModifier(allowances, result)
  }

  // 4. Task 5: Apply MPF deduction
  const totalAllowances = allowances.reduce((sum, a) => sum + a.amount, 0)
  const storeBonus = options?.storeBonus ?? 0
  const manualSplitPay = options?.splitPay
  const effectiveSplitPay = manualSplitPay != null ? manualSplitPay : (result.splitPay || 0)

  // ★ 病假扣減：只在 MONTHLY 分支接線（時薪員工天然零成本）
  const sickDeduction = (result.detail as any)?.monthlySalary != null
    ? await computeSickDeduction(employeeId, monthStart, monthEnd, (result.detail as any).monthlySalary, config.deduction_rate ?? 1, prisma, monthDate, (config as any).deduction_basis ?? 'workday', config.adw_policy, workData.monthlyWorkingDays)
    : { amount: 0, paidAmount: 0, episodes: [] }

  // ★ Phase 4: Maternity / Paternity pay (EO Ch.6 / Ch.7)
  const [maternityLeaves, paternityLeaves] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        leaveType: { systemKey: 'MATERNITY' },
        startDate: { lte: monthEnd },
        endDate: { gte: monthStart },
      },
    }),
    prisma.leaveRequest.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        leaveType: { systemKey: 'PATERNITY' },
        startDate: { lte: monthEnd },
        endDate: { gte: monthStart },
      },
    }),
  ])

  // --- Maternity pay ---
  let maternityPay = 0
  let maternityPayDetail: any = null
  let maternityDaysInMonth = 0
  let maternityStart: Date | null = null
  let maternityEnd: Date | null = null

  if (maternityLeaves.length > 0) {
    // Use the first maternity leave record's startDate as the official maternity start
    const firstMaternity = maternityLeaves[0]
    maternityStart = new Date(firstMaternity.startDate)
    maternityEnd = new Date(firstMaternity.endDate)

    // Collect all dates in this month that fall within maternity leave
    const maternityDays: Date[] = []
    for (const leave of maternityLeaves) {
      const effStart = new Date(Math.max(new Date(leave.startDate).getTime(), monthStart.getTime()))
      const effEnd = new Date(Math.min(new Date(leave.endDate).getTime(), monthEnd.getTime()))
      // ★ 唔好用 setHours —— 伺服器係 UTC，setHours(0,0,0,0) 設嘅係 UTC 午夜。
      //   而 monthStart/End 係 HK 邊界，兩種基準混合比較係靠巧合先啱。
      //   統一用 HK 日期字串迭代。
      let cur = toHKDateStr(effStart)
      const last = toHKDateStr(effEnd)
      while (cur <= last) {
        maternityDays.push(hkDateStart(cur))
        const nx = new Date(hkDateStart(cur).getTime() + 86400000)
        cur = toHKDateStr(nx)
      }
    }

    if (maternityDays.length > 0) {
      maternityDaysInMonth = maternityDays.length
      const matResult = await calculateMaternityPay(prisma, employeeId, maternityStart, maternityDays, (result.detail as any)?.monthlySalary, config.adw_policy)
      maternityPay = matResult.amount
      maternityPayDetail = {
        adw: matResult.adw,
        days: maternityDaysInMonth,
        capped: matResult.capped,
        governmentClaimable: matResult.governmentClaimable,
        startDate: toHKDateStr(maternityStart),
        endDate: toHKDateStr(maternityEnd),
        warnings: matResult.warnings.length > 0 ? matResult.warnings : undefined,
      }
    }
  }

  // --- Paternity pay ---
  let paternityPay = 0
  let paternityPayDetail: any = null
  let paternityDaysInMonth = 0

  if (paternityLeaves.length > 0) {
    const firstPaternity = paternityLeaves[0]
    const firstPaternityDay = new Date(firstPaternity.startDate)

    // Count paternity days in this month
    for (const leave of paternityLeaves) {
      const effStart = new Date(Math.max(new Date(leave.startDate).getTime(), monthStart.getTime()))
      const effEnd = new Date(Math.min(new Date(leave.endDate).getTime(), monthEnd.getTime()))
      // ★ 唔好用 setHours —— 同上。統一用 HK 日期字串迭代。
      let cur = toHKDateStr(effStart)
      const last = toHKDateStr(effEnd)
      while (cur <= last) {
        paternityDaysInMonth++
        const nx = new Date(hkDateStart(cur).getTime() + 86400000)
        cur = toHKDateStr(nx)
      }
    }

    if (paternityDaysInMonth > 0) {
      const patResult = await calculatePaternityPay(prisma, employeeId, firstPaternityDay, paternityDaysInMonth, (result.detail as any)?.monthlySalary, config.adw_policy)
      paternityPay = patResult.amount
      paternityPayDetail = {
        adw: patResult.adw,
        days: paternityDaysInMonth,
        startDate: toHKDateStr(firstPaternityDay),
        warnings: patResult.warnings.length > 0 ? patResult.warnings : undefined,
      }
    }
  }

  // ★ Phase 3: ADW calculation for holiday/leave adjustments
  // Calculate ADW once for the month; use month start as specified date
  let adwUsed: number | null = null
  let adwWarnings: string[] = []
  let adwSource: 'calculated' | 'fallback' | null = null
  let adwPolicyResult: AdwPolicyResult = {
    adw: 0, adwRaw: 0, policyApplied: 'none', currentEquivalent: 0,
  }
  const monthlySalary = (result.detail as any)?.monthlySalary ?? 0
  // ★ 用 monthlyWorkingDays（已扣休息日 + 公眾假期）。
  //   端午節已作為休息日發放，唔應該同時當工作日計入分母。
  const workingDays = (result.detail as any)?.monthlyWorkingDays
    ?? (result.detail as any)?.workingDays ?? 0
  const currentDailyRate = workingDays > 0 ? monthlySalary / workingDays : 0

  if (monthlySalary > 0) {
    try {
      const eff = await getEffectiveADW(prisma, employeeId, monthStart, monthlySalary, config.adw_policy)
      adwUsed = eff.adw
      adwWarnings = eff.warnings || []
      adwSource = 'calculated'
      adwPolicyResult = {
        adw: eff.adw,
        adwRaw: eff.adwRaw,
        policyApplied: eff.policyApplied,
        currentEquivalent: eff.currentEquivalent,
      }
      if (adwUsed <= 0) throw new Error('ADW calculated as 0 or negative')
    } catch (err) {
      // Fallback: use statutory daily wage
      adwUsed = statutoryDailyWage(monthlySalary)
      adwSource = 'fallback'
      adwWarnings = [`ADW fallback: ${err instanceof Error ? err.message : String(err)}`]
    }
  }

  // ★ Phase 3.5: cap audit trail
  if (adwPolicyResult.policyApplied === 'cap') {
    console.warn(
      `[adw_policy] ⚠️ cap 已套用 — employeeId=${employeeId} ` +
      `month=${toHKDateStr(monthDate).slice(0, 7)} ` +
      `raw=${adwPolicyResult.adwRaw.toFixed(2)} capped=${adwPolicyResult.adw.toFixed(2)} ` +
      `currentEquivalent=${adwPolicyResult.currentEquivalent.toFixed(2)}`,
    )
    // ★ 影響法定支付金額，要有永久紀錄
    await prisma.auditLog.create({
      data: {
        actorId: null,
        action: 'ADW_POLICY_CAP',
        entity: 'PayrollItem',
        entityId: employeeId,
        targetEmployeeId: employeeId,
        notes: `${toHKDateStr(monthDate).slice(0, 7)} ADW 上限：條例值 ${adwPolicyResult.adwRaw} → ${adwPolicyResult.adw}（現薪等值 ${adwPolicyResult.currentEquivalent}）`,
      },
    })
  }

  // ★ ADW adjustment for public holidays & paid leave (100% ADW per EO)
  // Current basePay uses monthlySalary/workingDays as effective daily rate
  // If ADW > currentDailyRate, we need to top up the difference for holiday/leave days
  // ★ Phase 4: Exclude public holidays falling within maternity leave (EO: only maternity pay applies)
  //   — 此時 adwUsed 已經係政策調整後嘅值
  const adwAdjustmentValue = (async (): Promise<number> => {
    if (adwUsed == null || adwUsed <= currentDailyRate) return 0

    let holidayDays = workData.publicHolidayDays

    // Exclude public holidays falling within maternity leave (EO: only maternity pay, no separate holiday pay)
    if (maternityStart && maternityEnd) {
      const rawHolidays = await getPublicHolidayDays(monthStart, monthEnd)
      const payableHolidays = filterHolidaysExcludingMaternity(
        rawHolidays,
        maternityStart,
        maternityEnd,
      ).length
      holidayDays = payableHolidays
    }

    // ★ ADW × 100% 補足只適用於法定假日、年假等「全薪」假期。
    //   病假 / 產假 / 侍產假 按 EO 係 ADW × 80%，而且已經分別由
    //   computeSickDeduction / maternityPay 處理 —— 計入呢度等於重複補足。
    const EIGHTY_PCT_KEYS = ['SICK', 'MATERNITY', 'PATERNITY']
    const fullPayLeaveDays = (workData.leaveByType ?? [])
      .filter((lt: any) => lt.isPaid && !EIGHTY_PCT_KEYS.includes(lt.systemKey))
      .reduce((sum: number, lt: any) => sum + lt.days, 0)

    const adjustmentDays = holidayDays + fullPayLeaveDays
    if (adjustmentDays <= 0) return 0
    return (adwUsed - currentDailyRate) * adjustmentDays
  })()

  const resolvedAdwAdjustment = await adwAdjustmentValue

  result.splitPay = effectiveSplitPay // 顯示與計算統一
  const grossPay = result.basePay - result.deduction + result.otPay + effectiveSplitPay + result.attendanceBonus + storeBonus + totalAllowances - sickDeduction.amount + (adwSource ? resolvedAdwAdjustment : 0) + maternityPay + paternityPay

  const mpfConfig = mods.mpf || config.mpf || { enabled: false }
  const mpf = calcMPF(grossPay, mpfConfig)
  const netPay = Math.max(0, grossPay - mpf)

  // ★ 雜項報銷 —— 報銷唔屬於 EO「工資」，唔計 MPF，喺 netPay 之後最後加
  const miscEntries = await prisma.expenseEntry.findMany({
    where: { employeeId, periodMonth: toHKDateStr(monthDate).slice(0, 7), status: 'APPROVED' },
  })
  const miscTotal = miscEntries.reduce((sum: number, e: any) => sum + e.amount, 0)
  result.totalPayable = netPay
  result.detail = {
    ...result.detail,
    storeBonus,
    grossPay: Math.round(grossPay * 100) / 100,
    mpf,
    mpfRate: (mods.mpf || config.mpf || {}).rate ?? 0.05,
    netPay: Math.round(netPay * 100) / 100,
    sickDeduction: sickDeduction.amount,
    sickEpisodes: sickDeduction.episodes,
    miscAmount: miscTotal,
    miscDetailJson: miscEntries.length > 0 ? JSON.stringify(miscEntries.map((e: any) => ({ amount: e.amount, description: e.description }))) : null,
    // ★ Phase 3: ADW info for audit/compliance
    adwUsed,
    adwSource,
    adwWarnings: adwWarnings.length > 0 ? adwWarnings : undefined,
    adwAdjustment: adwSource ? Math.round(resolvedAdwAdjustment * 100) / 100 : 0,
    // ★ Phase 3.5: ADW policy audit trail
    adwRaw: adwPolicyResult.adwRaw,
    adwPolicyApplied: adwPolicyResult.policyApplied,
    adwCurrentEquivalent: adwPolicyResult.currentEquivalent,
    // ★ Phase 4: Maternity / Paternity pay
    maternityPay,
    maternityPayDetail: maternityPayDetail || null,
    maternityDaysInMonth,
    paternityPay,
    paternityPayDetail: paternityPayDetail || null,
    paternityDaysInMonth,
  }

  // 5. Task 2: Count monthly leave days
  const restDaysConfig = mods.working_days?.rest_days ?? [6, 0] // 預設週六日
  // ★ 2026-08-02: 改用 DB 來源，同 monthlyWorkingDays 一致
  const _ph = await getPublicHolidayDays(monthStart, monthEnd)
  const _phSet = new Set(_ph.map(d => toHKDateStr(d)))
  const monthlyLeaveDays = countMonthlyLeaveDays(year, month, restDaysConfig, _phSet)
  let leaveBalanceRemaining = 0 // Tracked via LeaveBalance, not inline

  // 🔑 OT 唯一來源：時間銀行 otMinutes（排班外工時，分鐘制）
  // 提前呼叫 calculateTimeBank，後續 OT→Leave / 明細都用同一結果
  // ★ 即使 mods.time_bank 存在但結構唔同，都要有 negative_carry 預設值
  const timeBankConfig = {
    negative_carry: 'reset',
    ...(mods.time_bank ?? {}),
  }
  const tb = await calculateTimeBank(employeeId, monthDate, timeBankConfig, prisma)
  result.otHours = tb.otMinutes / 60 // 從分鐘換算，不自己算

  // ★ Bug 4 fix: Subtract lunch deduction from worked hours
  if (tb.totalLunchDeductMinutes > 0) {
    result.workedHours = Math.max(0, result.workedHours - tb.totalLunchDeductMinutes / 60)
  }

  // 🔑 重新計算 otPay — 之前用門檻制 otHours 算錯，現在用時間銀行 otMinutes 換算的小時數
  // ★ 2026-08-08: mode gate — time_off 模式下 otPay 恆為 0（止血防線）
  if ((mods.overtime?.mode ?? 'pay') !== 'time_off') {
    const hourlyEquivalent = (result.detail as any).hourlyEquivalent ?? 0
    const otMultiplier = (result.detail as any).otMultiplier ?? 1.5
    const oldOtPay = result.otPay
    result.otPay = Math.round(result.otHours * hourlyEquivalent * otMultiplier * 100) / 100
    const grossPayDelta = result.otPay - oldOtPay
    const oldGrossPay = (result.detail as any).grossPay ?? (result.basePay - result.deduction + oldOtPay + effectiveSplitPay + result.attendanceBonus)
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
  } else {
    // OT 只補時間：otHours 照更新（時間帳戶要），otPay 恆為 0
    result.otPay = 0
    result.detail = {
      ...result.detail,
      otMode: 'time_off',
      otHoursOff: result.otHours,
    }
  }

  // 7. Task 4: OT Balance —— 直接持久化 calculateTimeBank 嘅結果
  //
  // ★ 唔好喺呢度自己再算一次 balance。
  //   tb.balance 已經係 carriedFrom + netOtThisMonth + convertedMinutes（calculateTimeBank 內），
  //   舊版自己砌條式漏咗 convertedMinutes，令換假／初始調整全部被抹走 ——
  //   跑一次計糧，員工換咗嘅假就會「復活」成 OT。
  //
  // ★ 亦唔使再叫 getCarriedFrom —— calculateTimeBank 內部已經叫過，
  //   呢度係第二次遞歸，純浪費。
  await persistTimeBank(prisma, employeeId, monthDate, tb)

  // 8. Task 6 + TimeBank: Build comprehensive detail JSON with timebank data
  // tb already computed at line 1992 (OT唯一來源)
  const lateCount = workData.lateRecords.length
  const earlyLeaveCount = workData.earlyLeaveRecords?.length ?? 0

  const leaveTaken = workData.approvedLeaveDays

  // ★ OT 重算區塊（:2940）之後，result.detail.grossPay 已更新，
  //   但本地 const grossPay（:2886）仍係舊值 —— 一定要取最終值。
  const finalGrossPay = (result.detail as any).grossPay ?? grossPay
  const finalMpf = (result.detail as any).mpf ?? mpf
  const finalNetPay = (result.detail as any).netPay ?? netPay

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
      // ★ 2026-08-02: 扣薪分母四件套 —— 前端讀 detail.salary，
      //   之前只寫喺 calcMonthlyBase 嘅 detail 頂層，令 restDays 顯示 0。
      monthlyWorkingDays: (result.detail as any).monthlyWorkingDays ?? 0,
      restDaysInMonth: (result.detail as any).restDaysInMonth ?? 0,
      publicHolidayDays: (result.detail as any).publicHolidayDays ?? 0,
      calendarDays: (result.detail as any).calendarDays ?? 0,
      attendanceBonus: Math.round(result.attendanceBonus * 100) / 100,
      otPay: Math.round(result.otPay * 100) / 100,
      allowances: Math.round(totalAllowances * 100) / 100,
      sickDeduction: sickDeduction.amount,
      sickEpisodes: sickDeduction.episodes,
      grossPay: Math.round(finalGrossPay * 100) / 100,
      mpf: Math.round(finalMpf * 100) / 100,
      mpfRate: (mods.mpf || config.mpf || {}).rate ?? 0.05,
      netPay: Math.round(finalNetPay * 100) / 100,
    },
    // 假期與 OT
    leaveAndOt: {
      monthlyLeaveDays: monthlyLeaveDays.total,
      leaveTaken,                                          // 保留（向後相容）
      // ★ 拆開：只有 REST_DAY / ANNUAL_LEAVE / OT_LEAVE 會扣額度，
      //   病假／無薪假唔佔額度，混埋一齊顯示會令用家以為餘額被食咗
      leaveTakenQuota: (workData.leaveByType ?? [])
        .filter((lt: any) => QUOTA_LEAVE_KEYS.includes(lt.systemKey))
        .reduce((s: number, lt: any) => s + lt.days, 0),
      leaveTakenOther: (workData.leaveByType ?? [])
        .filter((lt: any) => !QUOTA_LEAVE_KEYS.includes(lt.systemKey))
        .reduce((s: number, lt: any) => s + lt.days, 0),
      leaveBalance: leaveBalanceRemaining,
      otHours: Math.round(result.otHours * 100) / 100,
      otBalanceMinutes: tb.balance ?? 0,
      timeAccountDetail: tb.timeAccountDetail || [],
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

  // ★ 雜項唯一加入點 —— 前面只設 netPay，唔可以喺嗰度加 miscTotal。
  // 擺喺最尾係為咗防止中間有新邏輯覆寫 totalPayable。
  // ⚠️ 改動呢行之前先 grep "totalPayable =" 確認冇第二處加 miscTotal。
  result.totalPayable = Math.max(0, result.totalPayable + miscTotal)

  // ★ EO「工資」總額（供 ADW 用）
  //
  //   定義：eoWage = grossPay − storeBonus
  //
  //   Gross 入面唯一唔屬 EO 第 2 條「工資」嘅係 storeBonus（老闆酌情花紅）。
  //   miscAmount（實報實銷）本身喺 MPF 之後先加，唔喺 grossPay 內，所以唔使另外減。
  //   adwAdjustment（法定假日／年假 ADW 補足）＝ 僱員當期合法賺取嘅工資，計入。
  //
  //   註：adwAdjustment 計入 eoWage 會產生輕微自我反饋（下一期 ADW 略升），
  //       增益約 holidayDays/365 ≈ 0.3%/年，數學上收斂，且符合 EO —— 屬預期行為。
  //
  //   ⚠️ 用推導式而唔用逐項列舉，係因為列舉式會 drift ——
  //      之前就係漏咗 `- result.deduction`，令有無薪假嘅月份 ADW 高估 20%。
  //      將來任何新增嘅 gross 項目會自動流入；如果新項目唔屬 EO 工資，
  //      喺下面 NON_EO_WAGE 度加返，一個地方維護。
  //
  //   ★ 2026-07-31 更正：店舖營業額獎金寫喺合約裡面（按營業額公式計，
  //     僱員有合理預期），屬 EO 第 2 條嘅「工資」，要計入。
  //     舊版當佢係酌情花紅剔出，係基於錯誤前提。
  //     EO 第 2 條剔除嘅係「非經常性 / 僱主酌情」嘅花紅 —— 目前系統冇呢類項目。
  //     miscAmount（實報實銷）本身喺 MPF 之後先加，唔喺 grossPay 內，唔使另外減。
  const NON_EO_WAGE = 0 // 目前 grossPay 入面冇任何唔屬 EO 工資嘅項目
  const eoWage = Math.round((finalGrossPay - NON_EO_WAGE) * 100) / 100

  // ★ 對帳 guard 永遠開 —— 計糧一個月一次，log 成本可忽略，
  //   而靜靜計錯數嘅代價遠高於一行 log。
  //   兩邊由唔同途徑得出（逐項砌 vs 經 OT 重算調整），所以呢個 guard 真係會 fire。
  //   註：eoWage 而家等於 grossPay（NON_EO_WAGE = 0），所以只需要驗呢一條。
  {
    const itemised =
      result.basePay
      - result.deduction
      + result.otPay // ← OT 重算後嘅值
      + effectiveSplitPay
      + result.attendanceBonus
      + storeBonus
      + totalAllowances
      - (sickDeduction.amount ?? 0)
      + (adwSource ? resolvedAdwAdjustment : 0)
      + maternityPay
      + paternityPay
    if (Math.abs(itemised - finalGrossPay) > 0.05) {
      console.warn(
        `[grossPay] 逐項加總對唔上 detail.grossPay：` +
        `employeeId=${employeeId} month=${toHKDateStr(monthDate).slice(0, 7)} ` +
        `itemised=${itemised.toFixed(2)} final=${finalGrossPay.toFixed(2)} ` +
        `diff=${(itemised - finalGrossPay).toFixed(2)}`,
      )
    }
  }

  // ★ 2026-08-10: 病假可以疊喺休息日／年假之上（leave-requests 已放行）——
  // excludedDays 一定要按【日期】去重，否則同一日會被病假同無薪假各計一次，
  // 令 ADW 分母偏差 → 病假／產假／法定假薪金全部錯。
  // ★ sickDays 必須同 excludedWage(paidAmount) 同源 ——
  // sickDeduction 只喺月薪員工計，時薪 episodes 係空。
  // 唔守住就會出現「有剔除日數、冇剔除工資」，污染 ADW。
  const sickCounted = (sickDeduction.episodes ?? []).length > 0

  const excludedDateSet = new Set<string>()

  // ① 病假日期（由 leaveByType 取得，sickDeduction.episodes 冇 dates 欄）
  if (sickCounted) {
    for (const lt of (workData.leaveByType ?? [])) {
      if (lt.systemKey === 'SICK') {
        for (const d of (lt.dates ?? [])) excludedDateSet.add(d)
      }
    }
  }
  const sickDays = excludedDateSet.size

  // ② 無薪類假期 —— 已經被病假覆蓋嘅日子唔再計
  let noPayLeaveDays = 0
  for (const lt of (workData.leaveByType ?? [])) {
    if (lt.isPaid !== false) continue
    for (const d of (lt.dates ?? [])) {
      if (excludedDateSet.has(d)) continue // ★ 已經計咗
      excludedDateSet.add(d)
      noPayLeaveDays++
    }
  }

  const maternityDays = (result.detail as any).maternityDaysInMonth ?? 0
  const paternityDays = (result.detail as any).paternityDaysInMonth ?? 0
  const absentDays = result.absentDays ?? 0

  const excludedDays = Math.round(sickDays + noPayLeaveDays + maternityDays + paternityDays + absentDays)
  // ⚠️ 已知限制：maternityDays / paternityDays 未入 excludedDateSet ——
  // 佢哋由 result.detail 嚟，冇日期清單。如果產假同病假／無薪假同日會 double count。
  // 實務罕見；真要修就要追 maternityDaysInMonth 嘅日期來源。
  const excludedWage = Math.round((
      // 病假：實付部分 = 應付日薪 × 日數 − 已扣減
      ((sickDeduction as any).paidAmount ?? 0)
    + 0                                              // 無薪假實收 0
    + ((result.detail as any).maternityPay ?? 0)
    + ((result.detail as any).paternityPay ?? 0)
  ) * 100) / 100

  ;(result.detail as any).eoWage = eoWage
  ;(result.detail as any).excludedDays = excludedDays
  ;(result.detail as any).excludedWage = excludedWage

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


