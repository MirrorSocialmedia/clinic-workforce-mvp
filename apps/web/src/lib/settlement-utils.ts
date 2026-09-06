/**
 * ★ 2026-09-05 [cwm-resigv3]：離職結算純函數工具（client-safe — 唔准 import prisma / payroll-engine）。
 *
 * 結算卡（React client 元件）同 e2e 共用同一來源：
 * - calcTimebankDebtAmount：時間帳戶欠款分鐘 → 日數/金額（|分| ÷ 9 小時工作日 × ADW）
 * - prefillTbDeduction：拍板② 扣除預填 = min(欠款, 1/4 上限)；正數餘額 → 0（永不負數）
 *
 * ⚠️ resign-settlement.ts 轉發呢兩個 export（settle route 由嗰度 import）—— 改動要同步。
 */

import { toHKDateStr, hkDateStart } from './hk-date'
import { getMpfExemption, adjustMpfMinForPeriod } from './mpf-exemption'
import { TIMEBANK_MINUTES_PER_DAY } from './timebank-constants'

/**
 * 時間帳戶欠款換算（EO s.32 口徑）：|tbMinutes| ÷ TIMEBANK_MINUTES_PER_DAY 日 × ADW
 * （9 小時標準工作日 = 1 日）。
 */
export function calcTimebankDebtAmount(tbMinutes: number, adwValue: number): { tbDays: number; tbAmount: number } {
  const tbDays = Math.round((Math.abs(tbMinutes) / TIMEBANK_MINUTES_PER_DAY) * 100) / 100
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

// ── MPF 顯示（2026-09-06 [cwm-mpf60-20260906]，MD §3.2）──────────────────
// 結算卡「強積金（僱員 5%）」行 + 零理由。豁免口徑同 engine 共用 mpf-exemption。
// ★ 法定默认（rate 5% / min 7100 / max 30000）—— 結算卡攞不到 clinic PayRule，
//   顯示層以法條為準（engine 實際扣款以 clinic config 為準，兩邊口徑一致嘅
//   係豁免判斷同基數組成）。

const MPF_RATE = 0.05
const MPF_MIN = 7100
const MPF_MAX = 30000
// ★ 2026-09-06 [cwm-caldayratio] 拍板③：不完整糧期下限 pro-rate — 同 engine 共用
//   adjustMpfMinForPeriod（mpf-exemption.ts）；唔同步 = 結算卡同 engine 走樣（mpf60 生死格 #9 同款坑）。
//   拍板④：MAX 30000 唔調（同 engine）。

export interface MpfDisplayResult {
  /** 僱員供款金額（$0.00 時 = 0） */
  employee: number
  /** 受僱曆日數（攞唔到 joinDate → null） */
  employedDays: number | null
  /** 有冇喺免供款期 */
  inExemptPeriod: boolean
  /** 0 時嘅理由（三選一；攞唔到 joinDate 時只剩入息判斷） */
  zeroReason: string | null
}

/**
 * 離職結算卡 MPF 顯示計算。
 * @param joinDate  入職日（API JSON → ISO string 或 Date 都得）
 * @param lastDayStr 最後工作日 'YYYY-MM-DD'（糧期 = 該月，拍板① 曆月）
 * @param relevantIncome 有關入息 = 當月工資 + 年假薪酬 + 代通知金 + 時間帳戶正數折現
 *   （拍板③ 折現計入）；唔包時間帳戶扣除（扣除喺 MPF 之後先扣）
 */
export function calcMpfDisplay(
  joinDate: Date | string | null | undefined,
  lastDayStr: string,
  relevantIncome: number,
): MpfDisplayResult {
  const join = joinDate
    ? (joinDate instanceof Date ? joinDate : hkDateStart(toHKDateStr(joinDate)))
    : null
  const ctx = {
    joinDate: join,
    periodMonth: lastDayStr ? hkDateStart(`${lastDayStr.slice(0, 7)}-01`) : null,
    lastDay: lastDayStr ? hkDateStart(lastDayStr) : null,
  }
  const ex = getMpfExemption(ctx)
  const employedDays = ex?.employedDays ?? null
  // ★ 2026-09-06 [cwm-caldayratio] 拍板③：下限按不完整糧期曆日比例（同 engine 同一 helper）
  const MIN = adjustMpfMinForPeriod(MPF_MIN, ctx)
  const fmt = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  if (ex && ex.employedDays < 60) {
    return { employee: 0, employedDays, inExemptPeriod: ex.inExemptPeriod, zeroReason: `受僱 ${ex.employedDays} 日（未滿 60 日，唔使登記）` }
  }
  if (ex && ex.inExemptPeriod) {
    return { employee: 0, employedDays, inExemptPeriod: true, zeroReason: '免供款期（首 30 日 ＋ 首個不完整糧期）' }
  }
  if (relevantIncome < MIN) {
    const proRated = MIN !== MPF_MIN
    return { employee: 0, employedDays, inExemptPeriod: false, zeroReason: `有關入息 ${fmt(relevantIncome)}（低於 ${fmt(MIN)}${proRated ? '（不完整糧期按比例）' : ''}）` }
  }
  return { employee: Math.round(Math.min(relevantIncome, MPF_MAX) * MPF_RATE * 100) / 100, employedDays, inExemptPeriod: false, zeroReason: null }
}
