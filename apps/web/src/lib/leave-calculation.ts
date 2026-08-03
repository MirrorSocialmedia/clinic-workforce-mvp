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
 * 年假累積明細 —— 拆開法定年假同生日假，畀 UI 顯示用。
 * ★ 2026-08-03：合約寫明「7 天年假 + 1 天生日假」，
 * 系統存埋一齊，UI 要拆返出嚟先對得上合約。
 */
export function annualLeaveBreakdown(
  joinDate: Date,
  asOf: Date,
  mode: 'earned' | 'prorata' = 'prorata',
): { annual: number; birthday: number; total: number } {
  const months = serviceMonths(joinDate, asOf)
  if (months < PROBATION_MONTHS) return { annual: 0, birthday: 0, total: 0 }

  const years = serviceYears(joinDate, asOf)
  let annual = 0
  let birthday = 0
  // ★ i < years = 只計完成咗嘅年度（earned）；i <= years = 加埋進行中嗰年（prorata）
  const last = mode === 'prorata' ? years : years - 1
  for (let i = 0; i <= last; i++) {
    annual += leaveForServiceYear(joinDate, i, asOf)

    // ★ 生日假唔按比例（2026-08-02 決定）——
    //   合約寫「每滿十二個月便可享有…1天」，「每滿」係條件，未滿就冇。
    //   所以只有【完成咗嘅服務年度】先計，prorata 模式下進行中嗰年唔加。
    const yearFullyCompleted = new Date(
      Date.UTC(hkParts(joinDate).y + i + 1, hkParts(joinDate).m - 1, hkParts(joinDate).day)
    ) <= asOf
    if (yearFullyCompleted) birthday += BIRTHDAY_LEAVE_DAYS
  }

  return {
    annual: Math.round(annual * 100) / 100,
    birthday,
    total: Math.round((annual + birthday) * 100) / 100,
  }
}

/**
 * 累計年假。
 *
 * @param mode
 * 'prorata' —— 按月比例累積（公司政策，2026-08-03 老闆決定）。
 * 進行中嘅服務年度按已過月數比例計。
 * ★ 日常餘額同離職結算【都用呢個】，兩者一致。
 * 'earned' —— 只計已完成嘅服務年度（EO s.41A 法定最低）。
 * 保留作參考，目前冇 caller。
 *
 * ★ 2026-08-03 更正：之前預設 'earned'（防止預支），
 * 但老闆確認公司政策係按月比例給。
 * 按月比例【優於法定】，而且令日常同離職口徑一致 ——
 * 員工放晒 prorata 嘅假之後離職，結算啱好係 0，唔會出現預支。
 */
export function totalAccruedLeave(
  joinDate: Date,
  asOf: Date,
  mode: 'earned' | 'prorata' = 'prorata', // ★ 預設改咗
): number {
  return annualLeaveBreakdown(joinDate, asOf, mode).total
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
