// ============================================================
// ★ cwm-payrollcols-20260918 B1：僱主強積金供款（純顯示／報表用）
//
// 🔴 僱主 MPF 唔可以照抄 calcMPF（嗰個係【僱員】供款）— 見 payroll-engine.ts
//    calcMPF docstring。兩者規則差三處，呢個 helper 逐字對住規則寫。
// ============================================================

import { getMpfExemption, type MpfCtx } from './mpf-exemption'

/**
 * ★ cwm-payrollcols-20260918：僱主強積金供款。
 *
 * ⚠️ 唔可以照抄 calcMPF（嗰個係【僱員】供款）—— 三處唔同：
 *   ① 月入 < 7,100：僱員免供，【僱主仍然要供 5%】
 *   ② 首 30 日免供款期：僱員免供，【僱主仍然要供】
 *   ③ 受僱 < 60 曆日：兩邊都唔使登記 → 0（相同）
 *   上限同樣 30,000 × 5% = 1,500。
 *
 * ★ 呢個數【純顯示／報表用】，唔會入 grossPay、唔會入 totalPayable、唔會扣員工錢。
 */
export function calcMpfEmployer(
  relevantIncome: number,
  config: { enabled?: boolean; rate?: number; max?: number },
  ctx?: MpfCtx | null,
): number {
  if (!config.enabled) return 0
  // ★ ③ 60 日規則兩邊通用；★ 唔好用 inExemptPeriod（嗰個只適用僱員）
  const exemption = ctx ? getMpfExemption(ctx) : null
  if (exemption && exemption.employedDays < 60) return 0

  const MAX = config.max ?? 30000
  const RATE = config.rate ?? 0.05
  const capped = Math.min(relevantIncome, MAX)   // ★ 冇 MIN 下限
  return Math.round(capped * RATE * 100) / 100
}
