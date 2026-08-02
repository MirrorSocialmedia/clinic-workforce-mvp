// ============================================================
// 年假核心計算函數 — 香港僱傭條例 + 跨年累積
// ============================================================

import { hkParts } from './hk-date'

// 年資額度對照表（可配置）
// Index 0 = 第1年, 1 = 第2年, ..., 8 = 第9年+
export const LEAVE_TABLE = [7, 7, 8, 9, 10, 11, 12, 13, 14] as const

// 試用期門檻（月）
export const PROBATION_MONTHS = 3 as const

// 每年天數（按比例計算用）
const YEAR_DAYS = 365

/**
 * 生日假（公司政策，合約第 8 條）—— 固定 1 天，唔跟年資階梯。
 * ★ 合併入年假額度發放，但唔加入 LEAVE_TABLE ——
 *   加入嘅話第 9 年會變 15 天（生日假變相變成 2 天）。
 */
export const BIRTHDAY_LEAVE_DAYS = 1 as const

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
 */
export function leaveForServiceYear(joinDate: Date, serviceYearIndex: number, asOf: Date): number {
  const j = hkParts(joinDate)
  // HK-safe anniversary dates via ISO string with +08:00
  const pad = (n: number) => String(n + 1).padStart(2, '0')
  const yearStart = new Date(`${j.y + serviceYearIndex}-${pad(j.m)}-${String(j.day).padStart(2, '0')}T00:00:00+08:00`)
  const yearEnd = new Date(`${j.y + serviceYearIndex + 1}-${pad(j.m)}-${String(j.day).padStart(2, '0')}T00:00:00+08:00`)
  const periodEnd = asOf < yearEnd ? asOf : yearEnd
  if (periodEnd <= yearStart) return 0

  const daysInThisYear = Math.floor((periodEnd.getTime() - yearStart.getTime()) / 86400000)
  const entitlement = LEAVE_TABLE[Math.min(serviceYearIndex, LEAVE_TABLE.length - 1)]
  // ★ 閏年（366 日）会令比例 > 1，令完整年度得出 7.02 —— clamp 住
  const ratio = Math.min(1, daysInThisYear / YEAR_DAYS)
  return entitlement * ratio
}

/**
 * 累計年假。
 *
 * @param mode
 * 'earned' —— 只計【已完成】嘅服務年度（EO s.41A：完成一個年度先賺到）。
 * 日常餘額顯示、請假扣減都用呢個。
 * 'prorata' —— 加埋【進行中】嗰年嘅按比例部分（EO s.41D：離職結算）。
 *
 * ★ 兩個數唔同係正確嘅 —— 唔好統一。日常用 earned 防止員工預支未賺到嘅假。
 */
export function totalAccruedLeave(
  joinDate: Date,
  asOf: Date,
  mode: 'earned' | 'prorata' = 'earned', // ★ 預設 earned（安全側）
): number {
  const months = serviceMonths(joinDate, asOf)
  if (months < PROBATION_MONTHS) return 0

  const years = serviceYears(joinDate, asOf)
  let total = 0
  // ★ i < years = 只計完成咗嘅年度；i <= years = 加埋進行中嗰年
  const last = mode === 'prorata' ? years : years - 1
  for (let i = 0; i <= last; i++) {
    total += leaveForServiceYear(joinDate, i, asOf)

    // ★ 生日假唔按比例（2026-08-02 決定）——
    //   合約寫「每滿十二個月便可享有…1天」，「每滿」係條件，未滿就冇。
    //   所以只有【完成咗嘅服務年度】先計，prorata 模式下進行中嗰年唔加。
    const yearFullyCompleted = new Date(
      Date.UTC(hkParts(joinDate).y + i + 1, hkParts(joinDate).m - 1, hkParts(joinDate).day)
    ) <= asOf
    if (yearFullyCompleted) total += BIRTHDAY_LEAVE_DAYS
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

  // ★ 離職結算要加埋進行中年度嘅按比例部分（EO s.41D）
  const accrued = totalAccruedLeave(joinDate, resignDate, 'prorata')
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
