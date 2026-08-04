// ============================================================
// 年假核心計算函數 — 香港僱傭條例 + 跨年累積
// ============================================================

import { hkParts } from './hk-date'

/**
 * 法定年假階梯（EO s.41）——【最低保障】，唔可以低過。
 * Index 0 = 第1年, 1 = 第2年, …, 8 = 第9年+
 */
export const STATUTORY_LEAVE_TABLE = [7, 7, 8, 9, 10, 11, 12, 13, 14] as const

/** @deprecated 改用 STATUTORY_LEAVE_TABLE */
export const LEAVE_TABLE = STATUTORY_LEAVE_TABLE

/**
 * 解析實際適用嘅年假階梯。
 *
 * ★ 容許逐個員工自訂（PayRule.modifiers.annual_leave.table），
 * 但【每一年都取自訂同法定嘅較大者】—— EO s.70 規定任何低過法定嘅條款無效。
 */
export function resolveLeaveTable(custom?: number[] | null): number[] {
  const N = STATUTORY_LEAVE_TABLE.length // 9
  if (!custom || custom.length === 0) return [...STATUTORY_LEAVE_TABLE]
  return Array.from({ length: N }, (_, i) => {
    const c = custom[Math.min(i, custom.length - 1)] ?? 0
    return Math.max(c, STATUTORY_LEAVE_TABLE[i])
  })
}

// 試用期門檻（月）
export const PROBATION_MONTHS = 3 as const

// 每年天數（按比例計算用）
const YEAR_DAYS = 365



/**
 * 根據服務年資返回年假額度
 * @param serviceYears 滿幾年（1-9+）
 * @param table 自訂年假階梯（預設法定）
 */
export function annualLeaveEntitlement(serviceYears: number, table?: number[]): number {
  const t = table ?? STATUTORY_LEAVE_TABLE
  const idx = Math.min(serviceYears - 1, t.length - 1)
  return idx < 0 ? 0 : t[idx]
}

/**
 * 計算兩個日期之間的天數
 */
export function serviceDays(joinDate: Date, asOf: Date): number {
  return Math.floor((asOf.getTime() - joinDate.getTime()) / 86400000)
}

/**
 * 計算滿幾年（整年）— 使用 HK 時區 safe 日期比較
 */
export function serviceYears(joinDate: Date, asOf: Date): number {
  const a = hkParts(asOf), j = hkParts(joinDate)
  let years = a.y - j.y
  if (a.m < j.m || (a.m === j.m && a.day < j.day)) years--
  return years
}

/**
 * 計算滿幾個月 — 使用 HK 時區 safe 日期比較
 */
export function serviceMonths(joinDate: Date, asOf: Date): number {
  const a = hkParts(asOf), j = hkParts(joinDate)
  let months = (a.y - j.y) * 12 + (a.m - j.m)
  // ★ 月尾入職（例如 3/31）遇上短月，a.day 永遠細過 j.day，
  //   會令試用期遲一日先過。用「當月最後一日」做 fallback。
  const lastDayOfAsOfMonth = new Date(Date.UTC(a.y, a.m + 1, 0)).getUTCDate()
  const effJoinDay = Math.min(j.day, lastDayOfAsOfMonth)
  if (a.day < effJoinDay) months--
  return months
}

/**
 * 計算某個服務年度的按比例年假 — 使用 HK 時區 safe 日期
 * @param joinDate 入職日期
 * @param serviceYearIndex 服務年度索引（0=第1年, 1=第2年...）
 * @param asOf 計算基準日
 * @param table 自訂年假階梯（預設法定）
 */
export function leaveForServiceYear(joinDate: Date, serviceYearIndex: number, asOf: Date, table?: number[]): number {
  const j = hkParts(joinDate)
  // HK-safe anniversary dates via ISO string with +08:00
  const pad = (n: number) => String(n + 1).padStart(2, '0')
  const yearStart = new Date(`${j.y + serviceYearIndex}-${pad(j.m)}-${String(j.day).padStart(2, '0')}T00:00:00+08:00`)
  const yearEnd = new Date(`${j.y + serviceYearIndex + 1}-${pad(j.m)}-${String(j.day).padStart(2, '0')}T00:00:00+08:00`)
  const periodEnd = asOf < yearEnd ? asOf : yearEnd
  if (periodEnd <= yearStart) return 0

  const daysInThisYear = Math.floor((periodEnd.getTime() - yearStart.getTime()) / 86400000)
  const t = table ?? STATUTORY_LEAVE_TABLE
  const entitlement = t[Math.min(serviceYearIndex, t.length - 1)]
  // ★ 閏年（366 日）会令比例 > 1，令完整年度得出 7.02 —— clamp 住
  const ratio = Math.min(1, daysInThisYear / YEAR_DAYS)
  return entitlement * ratio
}

/**
 * 累計年假（純法定，唔含生日假）。
 *
 * ★ 2026-08-04：生日假拆咗出去獨立計算 ——
 * 唔係每間公司都有，改由 PayRule.modifiers.birthday_leave 控制。
 * 見 accruedBirthdayLeave()。
 */
export function totalAccruedLeave(
  joinDate: Date,
  asOf: Date,
  mode: 'earned' | 'prorata' = 'prorata',
  table?: number[],
): number {
  const months = serviceMonths(joinDate, asOf)
  if (months < PROBATION_MONTHS) return 0

  const years = serviceYears(joinDate, asOf)
  let total = 0
  const last = mode === 'prorata' ? years : years - 1
  for (let i = 0; i <= last; i++) {
    total += leaveForServiceYear(joinDate, i, asOf, table)
  }
  return Math.round(total * 100) / 100
}

/**
 * 生日假累積天數。
 *
 * ★ 2026-08-04：由 PayRule.modifiers.birthday_leave 控制。
 * 唔按比例 —— 每滿一年先計。
 *
 * @param daysPerYear 每完成一年幾多天（PayRule 設定）
 */
export function accruedBirthdayLeave(
  joinDate: Date,
  asOf: Date,
  daysPerYear: number,
): number {
  if (!daysPerYear || daysPerYear <= 0) return 0

  const years = serviceYears(joinDate, asOf)
  if (years < 1) return 0

  const j = hkParts(joinDate)
  let count = 0
  for (let i = 0; i < years; i++) {
    const anniversary = new Date(
      `${j.y + i + 1}-${String(j.m + 1).padStart(2, '0')}-${String(j.day).padStart(2, '0')}T00:00:00+08:00`,
    )
    if (anniversary <= asOf) count++
  }
  return count * daysPerYear
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
  table?: number[],
): LeaveSettlement {
  const months = serviceMonths(joinDate, resignDate)
  if (months < PROBATION_MONTHS) {
    return { accrued: 0, used: usedDays, unused: 0, payout: 0 }
  }

  // ★ 離職結算要加埋進行中年度嘅按比例部分（EO s.41D）
  const accrued = totalAccruedLeave(joinDate, resignDate, 'prorata', table)
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
