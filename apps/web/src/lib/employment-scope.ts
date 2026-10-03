// ============================================================
// ★ cwm-resignsweep-20261003：已離職員工嘅「仲算唔算喺度」判斷（共用）
//
// 語義（同 resign-cutoff 一致，唔准改）：
//   leaveDate  = 最後工作日（HK 00:00）
//   resignedAt = 生效日 = 最後工作日 + 1（HK 00:00）—— exclusive
// 舊數據（resignflow 之前）可能冇 resignedAt → 用 leaveDate；兩樣都冇 → 當已經走咗。
// ============================================================
import type { Prisma } from '@prisma/client'
import { toHKDateStr, addDaysStr } from '@/lib/hk-date'

/**
 * where 條件：喺 `from`（含）或之後仍然受僱嘅員工。
 * 未離職一律入；已離職只入「生效日 > from」嗰啲（即 from 當日或之後仲有返工日）。
 */
export function employedFromWhere(from: Date): Prisma.EmployeeWhereInput {
  return {
    OR: [
      { status: { not: 'RESIGNED' } },
      { resignedAt: { gt: from } },
      { resignedAt: null, leaveDate: { gte: from } },
    ],
  }
}

/** where 條件：未離職（列表／下拉／批量操作用 —— 唔理日子） */
export const NOT_RESIGNED_WHERE: Prisma.EmployeeWhereInput = { status: { not: 'RESIGNED' } }

/**
 * 已離職員工第一個「唔再受僱」嘅 HK 日子（YYYY-MM-DD）；未離職 = null。
 * 由呢日起唔准排更／請假。冇任何日子嘅舊數據 → 由聽日起擋（今日或之前嘅修正照准）。
 */
export function resignedFromDateStr(
  emp: { status: string; resignedAt: Date | null; leaveDate: Date | null },
  todayStr: string,
): string | null {
  if (emp.status !== 'RESIGNED') return null
  if (emp.resignedAt) return toHKDateStr(emp.resignedAt)
  if (emp.leaveDate) return addDaysStr(toHKDateStr(emp.leaveDate), 1)
  return addDaysStr(todayStr, 1)
}

/**
 * 檢查一串 HK 日子有冇落喺離職生效日或之後；有就回錯誤訊息（null = 冇問題）。
 */
export function resignedDateError(
  emp: { status: string; resignedAt: Date | null; leaveDate: Date | null },
  dates: string[],
  todayStr: string,
): string | null {
  const from = resignedFromDateStr(emp, todayStr)
  if (!from) return null
  const bad = dates.filter(d => d >= from).sort()[0]
  if (!bad) return null
  return `員工已離職（${from} 起唔再受僱），唔可以喺 ${bad} 排更／請假`
}

/**
 * 前端／純函數版 employedFromWhere：員工喺 fromStr（HK YYYY-MM-DD）當日或之後仲有冇受僱日。
 * 排班總覽用 —— 離職當月照顯示，之後先撤走。
 */
export function employedOnOrAfterStr(
  emp: { status: string; resignedAt?: Date | string | null; leaveDate?: Date | string | null },
  fromStr: string,
): boolean {
  if (emp.status !== 'RESIGNED') return true
  if (emp.resignedAt) return toHKDateStr(emp.resignedAt) > fromStr
  if (emp.leaveDate) return toHKDateStr(emp.leaveDate) >= fromStr
  return false
}
