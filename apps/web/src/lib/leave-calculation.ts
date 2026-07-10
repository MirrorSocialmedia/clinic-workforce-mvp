// ============================================================
// 年假核心計算函數 — 香港僱傭條例 + 跨年累積
// ============================================================

// 年資額度對照表（可配置）
// Index 0 = 第1年, 1 = 第2年, ..., 8 = 第9年+
export const LEAVE_TABLE = [7, 7, 8, 9, 10, 11, 12, 13, 14] as const

// 試用期門檻（月）
export const PROBATION_MONTHS = 3 as const

// 每年天數（按比例計算用）
const YEAR_DAYS = 365

/**
 * 根據服務年資返回年假額度
 * @param serviceYears 滿幾年（1-9+）
 */
export function annualLeaveEntitlement(serviceYears: number): number {
  const idx = Math.min(serviceYears - 1, LEAVE_TABLE.length - 1)
  return idx < 0 ? 0 : LEAVE_TABLE[idx]
}

/**
 * 計算兩個日期之間的天數
 */
export function serviceDays(joinDate: Date, asOf: Date): number {
  return Math.floor((asOf.getTime() - joinDate.getTime()) / 86400000)
}

/**
 * 計算滿幾年（整年）
 */
export function serviceYears(joinDate: Date, asOf: Date): number {
  let years = asOf.getFullYear() - joinDate.getFullYear()
  const anniv = new Date(joinDate)
  anniv.setFullYear(joinDate.getFullYear() + years)
  if (anniv > asOf) years--
  return years
}

/**
 * 計算滿幾個月
 */
export function serviceMonths(joinDate: Date, asOf: Date): number {
  let months = (asOf.getFullYear() - joinDate.getFullYear()) * 12
    + (asOf.getMonth() - joinDate.getMonth())
  if (asOf.getDate() < joinDate.getDate()) months--
  return months
}

/**
 * 計算某個服務年度的按比例年假
 * @param joinDate 入職日期
 * @param serviceYearIndex 服務年度索引（0=第1年, 1=第2年...）
 * @param asOf 計算基準日
 */
export function leaveForServiceYear(joinDate: Date, serviceYearIndex: number, asOf: Date): number {
  const yearStart = new Date(joinDate)
  yearStart.setFullYear(joinDate.getFullYear() + serviceYearIndex)
  const yearEnd = new Date(joinDate)
  yearEnd.setFullYear(joinDate.getFullYear() + serviceYearIndex + 1)
  const periodEnd = asOf < yearEnd ? asOf : yearEnd
  if (periodEnd <= yearStart) return 0

  const daysInThisYear = Math.floor((periodEnd.getTime() - yearStart.getTime()) / 86400000)
  const entitlement = LEAVE_TABLE[Math.min(serviceYearIndex, LEAVE_TABLE.length - 1)]
  return entitlement * daysInThisYear / YEAR_DAYS
}

/**
 * 累計總應得年假（從入職到基準日所有服務年度的加總）
 * 不足試用期（3個月）→ 0
 */
export function totalAccruedLeave(joinDate: Date, asOf: Date): number {
  const months = serviceMonths(joinDate, asOf)
  if (months < PROBATION_MONTHS) return 0

  const years = serviceYears(joinDate, asOf)
  let total = 0
  for (let i = 0; i <= years; i++) {
    total += leaveForServiceYear(joinDate, i, asOf)
  }
  return Math.round(total * 100) / 100
}

/** 離職結算結果 */
export interface LeaveSettlement {
  accrued: number   // 累計應得
  used: number      // 已用
  unused: number    // 未放
  payout: number    // 折算金額
}

/**
 * 離職時年假結算
 * - 不足3個月→全部歸零
 * - 滿3個月→未放部分按月薪折算
 * 折算公式：未放天數 × 月薪 × 12 ÷ 365
 */
export function settleLeaveOnResign(
  joinDate: Date,
  resignDate: Date,
  monthlySalary: number,
  usedDays: number,
): LeaveSettlement {
  const months = serviceMonths(joinDate, resignDate)
  if (months < PROBATION_MONTHS) {
    return { accrued: 0, used: usedDays, unused: 0, payout: 0 }
  }

  const accrued = totalAccruedLeave(joinDate, resignDate)
  const unused = Math.max(0, accrued - usedDays)
  const dailyWage = monthlySalary * 12 / YEAR_DAYS
  const payout = Math.round(unused * dailyWage * 100) / 100
  return { accrued, used: usedDays, unused, payout }
}

/**
 * 檢查員工是否在試用期內（不足 PROBATION_MONTHS 個月）
 */
export function isInProbation(joinDate: Date, asOf: Date = new Date()): boolean {
  return serviceMonths(joinDate, asOf) < PROBATION_MONTHS
}
