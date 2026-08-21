// ============================================================
// 月視圖假期總覽 helpers（2026-08-21，cw-plmemo-20260821-a1 §3）
// 純函數、零 prisma —— 俾 API route（scheduling-leave-summary）同單測共用。
//
// 拍板：②R/PL 用 (a) PL 係 R 子集 ③年假三數（上月剩→餘/本月用→已放/本月剩→…）
//       時間基準：R/PL = 曆月、年假 = 服務年度（唔係曆年）
// ============================================================

import { toHKDateStr, addDaysStr } from './hk-date'
import { annualLeaveEntitlement } from './leave-calculation'

/** UTC Date → 'YYYY-MM-DD'（純日期欄位，唔經 Intl） */
function toUTCDateStr(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * 由 joinDate 推「asOf 所屬嘅服務年度」區間（HK 日字串 YYYY-MM-DD）。
 *
 * - 邊界 = 週年日；週年當日就切新年度（asOf === anniv → 新年度）。
 * - ★ 2 月 29 日入職：非閏年週年用 `Date.UTC(y, m-1, 29)` 自動 roll 去 3/1
 *   （跟 repo 一致嘅建構方式；唔好直接用字串 '02-29' —— 非閏年係 Invalid Date）。
 * - index = 第幾個服務年度（0-based）。★ 直接餵 entitledForServiceYear，
 *   唔好自己 serviceYears() 再算一次。
 */
export function serviceYearRange(joinDate: Date, asOf: Date): { start: string; end: string; index: number } {
  const j = toHKDateStr(joinDate)
  const [jy, jm, jd] = j.split('-').map(Number)
  const a = toHKDateStr(asOf)
  const [ay] = a.split('-').map(Number)

  // 今年嘅週年日（UTC 建構；2/29 非閏年自動 roll 去 3/1）
  const annivStr = toUTCDateStr(new Date(Date.UTC(ay, jm - 1, jd)))
  let startY = ay
  if (a < annivStr) startY = ay - 1 // ★ 未到今年週年 → 上一個年度

  const start = toUTCDateStr(new Date(Date.UTC(startY, jm - 1, jd)))
  const end = toUTCDateStr(new Date(Date.UTC(startY + 1, jm - 1, jd) - 86400000))
  return { start, end, index: startY - jy }
}

/**
 * 某服務年度嘅「應得」年假 —— 該年度**全額**（唔係「截至今日累積」）。
 *
 * ★ 2026-08-22 §6.1：月視圖總覽要「本年度應得全額」。
 *   舊實現重用 leaveForServiceYear —— 佢係「截至今日累積」（× 已過日數/365），
 *   為離職結算按比例而寫（年中會出 6.2 天，實測 bug）。
 *   改用 annualLeaveEntitlement（純表查詢、無日期計算）→
 *   2/29 入職 fallback 一併移除（唔再經字串建日期，NaN 問題唔存在）。
 * ★ serviceYearIndex = serviceYearRange().index（0-based）。
 *   ★ 注意：annualLeaveEntitlement 個參數係 1-based「第幾年」（內部 idx = 參數 − 1，
 *   第 1 年傳 1），所以呢度傳 serviceYearIndex + 1 先取得到表入面 [index] 嗰格。
 */
export function entitledForServiceYear(serviceYearIndex: number, table?: number[]): number {
  return annualLeaveEntitlement(serviceYearIndex + 1, table)
}

/**
 * 假期記錄同日期區間有冇重疊（兩端 inclusive，'YYYY-MM-DD' 字串比較）。
 * ⚠️ 跨服務年度嘅假期只判斷「有冇重疊」—— 全部 `days` 會落當前年度
 *    （罕見，第一版唔切分，2026-08-21 記低）。
 */
export function overlapsRange(
  lr: { startDate: Date | string; endDate: Date | string },
  start: string,
  end: string,
): boolean {
  const s = toHKDateStr(lr.startDate)
  const e = toHKDateStr(lr.endDate)
  return s <= end && e >= start
}

/**
 * 把假期記錄展開成逐日日期，連續嘅合併成 '6/8–6/9'，多段用 '、' 分開。
 *
 * ⚠️ 要展開成日期先合併 —— 直接用 startDate–endDate 會令「8/20 一日」同
 * 「8/21 一日」兩張獨立申請顯示成「8/20、8/21」而唔係「8/20–8/21」。
 */
export function formatTakenDates(taken: { startDate: Date | string; endDate: Date | string }[]): string {
  const days = new Set<string>()
  for (const lr of taken) {
    let d = toHKDateStr(lr.startDate)
    const e = toHKDateStr(lr.endDate)
    let guard = 0
    while (d <= e && guard++ < 400) { days.add(d); d = addDaysStr(d, 1) }
  }
  const sorted = [...days].sort()
  const out: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && addDaysStr(sorted[j], 1) === sorted[j + 1]) j++
    const md = (s: string) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`
    out.push(i === j ? md(sorted[i]) : `${md(sorted[i])}–${md(sorted[j])}`)
    i = j + 1
  }
  return out.join('、')
}

export interface RestPlCounts {
  restOnly: number // R：本月 REST_DAY 而冇 PL 標記
  pl: number       // PL：本月 REST_DAY 而 isEmployeeRequested = true
  total: number    // R + PL（拍板②a：PL 係 R 子集，三欄相加得返）
}

/**
 * 本月 REST_DAY 按員工聚合成 R/PL（拍板②a）。
 *
 * - 逐日展開 + Set 去重（同一日重複申請只計一次）。
 * - clip 到 [monthStart, monthEnd] —— 範圍查詢會攞返跨月邊界嘅記錄。
 * - 唔係 REST_DAY 嘅記錄（病假等）直接跳過。
 */
export function aggregateRestPl(
  leaveRequests: {
    employeeId: string
    startDate: Date | string
    endDate: Date | string
    isEmployeeRequested: boolean
    leaveType?: { systemKey?: string | null } | null
  }[],
  monthStart: string,
  monthEnd: string,
): Record<string, RestPlCounts> {
  const byEmp = new Map<string, { rest: Set<string>; pl: Set<string> }>()
  for (const lr of leaveRequests) {
    if (lr.leaveType?.systemKey !== 'REST_DAY') continue
    let d = toHKDateStr(lr.startDate)
    const e = toHKDateStr(lr.endDate)
    const slot = byEmp.get(lr.employeeId) ?? { rest: new Set<string>(), pl: new Set<string>() }
    let guard = 0
    while (d <= e && guard++ < 400) {
      if (d >= monthStart && d <= monthEnd) {
        (lr.isEmployeeRequested ? slot.pl : slot.rest).add(d)
      }
      d = addDaysStr(d, 1)
    }
    byEmp.set(lr.employeeId, slot)
  }
  const out: Record<string, RestPlCounts> = {}
  for (const [id, s] of byEmp) {
    out[id] = { restOnly: s.rest.size, pl: s.pl.size, total: s.rest.size + s.pl.size }
  }
  return out
}
