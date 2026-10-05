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

/**
 * ★ 2026-09-30 [cwm-restdebt]：離職超額休息日 = 休息日帳（REST_DAY LeaveBalance）截至最後工作日嘅透支。
 *   舊版只倒推最後一個月（受僱曆日 − 有更日 − 年假／病假 − 公眾假期）+ 做足月短路：
 *   ① 之前月份預支（「下個月還」）永遠追唔返（CC2 −2 日 → $0）
 *   ② 無薪假／生日假／補假／空白日被當休息日 → 雙重扣
 *   ③ 發放額度包公眾假期、倒推剔走公眾假期 → 少扣
 *   新版只讀休息日帳（同排班「上月剩」、薪資明細同一個 helper），同次序無關。
 * ⚠️ 當月發放係月頭一次過入帳；最後一個月未做完嘅部分按曆日比例唔應得。
 * ⚠️ max(0, …) —— 冇透支唔會變加錢（休息日唔換錢，EO s.17，MD §4.3）。
 */
export function calcRestDayDebt(a: {
  entitledAsOf: number          // restDayBalanceAsOf.entitled（已剔走最後工作日之後嘅發放）
  usedAsOf: number              // restDayBalanceAsOf.used（已剔走最後工作日之後嘅休息日／換鐘）
  monthlyRestGrantDays: number  // 最後工作日當月 RESTDAY_GRANT 日數
  employedDays: number          // 當月受僱曆日（含頭含尾）
  monthDays: number             // 當月曆日
  monthlySalary: number
}): { entitledRestDays: number; usedRestDays: number; unearnedThisMonth: number; excessDays: number; amount: number } {
  const r2 = (n: number) => Math.round(n * 100) / 100
  const unearnedThisMonth = a.monthDays > 0 && a.employedDays < a.monthDays
    ? r2(a.monthlyRestGrantDays * (a.monthDays - a.employedDays) / a.monthDays)
    : 0
  const entitledRestDays = r2(a.entitledAsOf - unearnedThisMonth)
  const usedRestDays = r2(a.usedAsOf)
  const excessDays = Math.max(0, r2(usedRestDays - entitledRestDays))
  const dailyRate = a.monthDays > 0 ? a.monthlySalary / a.monthDays : 0
  return { entitledRestDays, usedRestDays, unearnedThisMonth, excessDays, amount: r2(excessDays * dailyRate) }
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

// ── 離職結算 = 月結同一條數（2026-09-30 [cwm-resignfull]）────────────────
// 舊版結算卡「當月工資」只讀 basePay → 勤工獎／OT／津貼／店舖獎金／扣減／雜項報銷全部唔見，
// 結算書「預估應付」同月結「實發」對唔上（CC2：$15,586.68 vs $16,163.08，差 = 勤工獎 500 − MPF 25 + 雜項 101.40）。
// 而家當月各項由引擎出（resign-settlement.ts monthItems），加總口徑同 engine grossPay／netPay 一模一樣。

export type BonusOverride = 'FORCE_ON' | 'FORCE_OFF'
/** 結算卡揀法：'AUTO' = 明確「按考勤自動」（蓋過舊計糧單嘅 FORCE_*）；null = 冇揀（跟計糧單） */
export type SettlementBonusChoice = BonusOverride | 'AUTO'
/** 'AUTO' → 引擎 null（自動）；其餘原樣 */
export function toEngineBonusOverride(v: SettlementBonusChoice | null | undefined): BonusOverride | null {
  return v === 'FORCE_ON' || v === 'FORCE_OFF' ? v : null
}

/**
 * 勤工獎覆蓋／店舖獎金嘅揀法優先次序（計糧生成、計糧預覽、結算卡三處共用）：
 *   計糧頁今次輸入 > 離職結算已存 > 舊計糧單 carry-forward > 冇
 * null／undefined = 「冇揀」→ 落去下一層；0 係有效值（店舖獎金填 0 = 唔發）。
 */
export function pickResignChoice<T>(explicit: T | null | undefined, settlement: T | null | undefined, carried: T | null | undefined): T | null {
  return explicit ?? settlement ?? carried ?? null
}

/** 當月各項（引擎直算，未計離職結算項）— 結算卡／結算書逐行顯示 */
export interface ResignMonthItems {
  payType: 'MONTHLY' | 'HOURLY'
  basePay: number
  attendanceBonus: number
  attendanceBonusReason: string | null
  otPay: number
  splitPay: number
  storeBonus: number
  allowances: number
  deduction: number        // 缺勤扣減（正數 = 扣）
  sickDeduction: number    // 病假扣減（正數 = 扣）
  adwAdjustment: number    // 法定假日／年假 ADW 補足（可正可負）
  maternityPay: number
  paternityPay: number
  otherAdjust: number      // 引擎 grossPay − 上面逐項（正常 0；防將來新項目漏行）
  grossPay: number         // 當月 Gross（未計年假／通知金／折現／超額休息日）
  miscAmount: number       // 雜項報銷（MPF 之後加，唔屬工資）
  miscEntries: Array<{ amount: number; description: string | null }>
  mpfEnabled: boolean      // 薪酬規則有冇開 MPF（時薪 = false，同引擎一致）
}

/**
 * 預估應付（同 engine 月薪／時薪路徑同一條式）：
 *   有關入息 = 當月 Gross + 年假薪酬 + 代通知金 + 時間帳戶正數折現 − 超額休息日
 *   淨額     = max(0, 有關入息 − MPF(僱員) − 時間帳戶欠款扣除)
 *   應付     = 淨額 + 雜項報銷
 */
export function calcResignPayable(a: {
  monthGross: number
  annualLeavePay: number
  noticePay: number
  tbCashout: number
  excessRest: number
  mpfEmployee: number
  tbDeduction: number
  misc: number
}): { relevantIncome: number; net: number; payable: number } {
  const r2 = (n: number) => Math.round(n * 100) / 100
  const n = (v: number) => Number(v) || 0
  const relevantIncome = r2(n(a.monthGross) + n(a.annualLeavePay) + n(a.noticePay) + Math.max(0, n(a.tbCashout)) - Math.max(0, n(a.excessRest)))
  const net = Math.max(0, r2(relevantIncome - n(a.mpfEmployee) - Math.max(0, n(a.tbDeduction))))
  const payable = Math.max(0, r2(net + n(a.misc)))
  return { relevantIncome, net, payable }
}
