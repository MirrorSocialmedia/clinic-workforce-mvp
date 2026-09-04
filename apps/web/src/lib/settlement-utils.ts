/**
 * ★ 2026-09-05 [cwm-resigv3]：離職結算純函數工具（client-safe — 唔准 import prisma / payroll-engine）。
 *
 * 結算卡（React client 元件）同 e2e 共用同一來源：
 * - calcTimebankDebtAmount：時間帳戶欠款分鐘 → 日數/金額（|分|/540 日 × ADW）
 * - prefillTbDeduction：拍板② 扣除預填 = min(欠款, 1/4 上限)；正數餘額 → 0（永不負數）
 *
 * ⚠️ resign-settlement.ts 轉發呢兩個 export（settle route 由嗰度 import）—— 改動要同步。
 */

/**
 * 時間帳戶欠款換算（EO s.32 口徑）：|tbMinutes|/540 日 × ADW。
 * 540 分 = 9 小時標準工作日。
 */
export function calcTimebankDebtAmount(tbMinutes: number, adwValue: number): { tbDays: number; tbAmount: number } {
  const tbDays = Math.round((Math.abs(tbMinutes) / 540) * 100) / 100
  const tbAmount = Math.round(tbDays * adwValue * 100) / 100
  return { tbDays, tbAmount }
}

/**
 * 拍板②：扣除預填 = min(欠款金額, 1/4 工資期上限)。
 * 正數餘額（欠款 0）→ 0；入參負數一律 clip 0（永不預填負數）。
 */
export function prefillTbDeduction(debtAmount: number, quarterCap: number): number {
  const debt = Math.max(0, Number(debtAmount) || 0)
  const cap = Math.max(0, Number(quarterCap) || 0)
  return Math.round(Math.min(debt, cap) * 100) / 100
}
