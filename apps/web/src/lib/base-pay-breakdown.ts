/**
 * ★ 2026-09-30 [cwm-rosterjoin]：月薪「底薪點計」明細（client-safe 純函數）
 *
 * 引擎口徑（payroll-engine runMonthlyBase / resolveEmployedRatio）：
 *   底薪 = 月薪 × 倍數 × 受僱比例；受僱比例 = 受僱曆日（含頭含尾、含休息日）÷ 當月曆日
 *   例：9/8 入職、月薪 $14,000 → 14,000 × 23 ÷ 30 = $10,733.33
 *
 * 新 run：讀 detail.employedRatioDetail（numerator／denominator／from／to）。
 * 舊 run（冇 from/to 或冇 detail）：用入職日／resignedAt（= 最後工作日翌日）推返，同引擎同一條式。
 */
import { toHKDateStr, addDaysStr } from './hk-date'

export interface BasePayBreakdown {
  monthlySalary: number
  multiplier: number
  full: boolean            // 全月受僱（ratio 1）
  employedDays: number
  monthDays: number
  from: string | null
  to: string | null
  computed: number         // 按明細重算嘅底薪（2 位小數）
  matches: boolean         // 同糧單 basePay 對唔對得上（±0.01）
}

export function describeBasePay(a: {
  basePay: number
  monthlySalary: number | null | undefined
  multiplier?: number | null
  ratio?: number | null
  ratioDetail?: { numerator?: number; denominator?: number; from?: string | null; to?: string | null } | null
  periodMonth: string               // 'YYYY-MM'
  joinDate?: Date | string | null
  resignedAt?: Date | string | null // 最後工作日翌日（exclusive）
}): BasePayBreakdown | null {
  const monthlySalary = Number(a.monthlySalary)
  if (!Number.isFinite(monthlySalary) || monthlySalary <= 0) return null
  const multiplier = Number(a.multiplier) > 0 ? Number(a.multiplier) : 1

  const [y, m] = a.periodMonth.split('-').map(Number)
  const monthDays = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const monthStartStr = `${a.periodMonth}-01`
  const monthEndStr = `${a.periodMonth}-${String(monthDays).padStart(2, '0')}`

  let from: string | null = a.ratioDetail?.from ?? null
  let to: string | null = a.ratioDetail?.to ?? null
  if (!from || !to) {
    const joinStr = a.joinDate ? toHKDateStr(a.joinDate) : null
    const lastStr = a.resignedAt ? addDaysStr(toHKDateStr(a.resignedAt), -1) : null
    from = joinStr && joinStr > monthStartStr ? joinStr : monthStartStr
    to = lastStr && lastStr < monthEndStr ? lastStr : monthEndStr
    if (from > to) { from = null; to = null }
  }
  let employedDays = 0
  if (from && to) for (let d = from; d <= to; d = addDaysStr(d, 1)) employedDays++
  if (typeof a.ratioDetail?.numerator === 'number' && typeof a.ratioDetail?.denominator === 'number' && a.ratioDetail.denominator > 0) {
    employedDays = a.ratioDetail.numerator
  }

  const full = employedDays >= monthDays
  const ratio = full ? 1 : employedDays / monthDays
  const computed = Math.round(monthlySalary * multiplier * ratio * 100) / 100
  return {
    monthlySalary, multiplier, full, employedDays, monthDays, from, to, computed,
    matches: Math.abs(computed - (Number(a.basePay) || 0)) <= 0.01,
  }
}
