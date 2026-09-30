/**
 * 離職結算計算（共用）— cwm-resigpay-20260904
 *
 * resign-preview（GET 預覽）同 resign-settle（POST 寫入）共用同一套計算，
 * 確保預覽 = 寫入 = 伺服器驗證（s.32 上限）同一口徑，唔會兩邊走樣。
 *
 * 口徑（全部沿用 2026-09-02 cwm-resigsettle 拍板）：
 * - cutoff = 最後工作日**結束**（翌日 HK 午夜）—— 同 resign/route.ts 一致
 * - 未放年假薪酬／代通知金 = 日數 × Effective ADW（拍板②）
 * - 時間帳戶欠款唔自動扣，人手輸入；EO s.32 單項扣除 ≤ 該工資期工資 1/4
 * - ★ 2026-09-05 [cwm-resigv3] 當月工資「讀唔算」：resolveMonthWage 三段 fallback
 *   （PayrollItem 已生成 → 引擎直算 → none），finalPeriodWage（1/4 上限基數）
 *   改用 prorate 後嘅當月工資（MD §2.3 #8 — 全月薪會高估上限 2.7 倍）
 */
import { PrismaClient } from '@prisma/client'
import { hkDateStart, hkDateEnd, toHKDateStr, periodMonthKey, getMonthRange, hkDaysInMonth, countHKDaysInclusive } from './hk-date'
import { calculatePayrollWithRules, calculateTimeBank, timeBankCacheKey } from './payroll-engine'
import { settleLeaveOnResign, totalAccruedLeave, serviceMonths } from './leave-calculation'
import { LEAVE_SYSTEM_KEYS } from './leave-types'
import { getEffectiveADW } from './adw'
import { TIMEBANK_MINUTES_PER_DAY } from './timebank-constants'
import { calcRestDayDebt } from './settlement-utils'
import { restDayBalanceAsOf } from './leave-balance-as-of'
import { futureAnnualLeaveDays } from './resign-cutoff'
import { findPayRuleForMonth } from './pay-rule-for-month'
import { pickResignChoice, toEngineBonusOverride, type ResignMonthItems, type BonusOverride, type SettlementBonusChoice } from './settlement-utils'

export interface ResignSettlementCalc {
  monthlySalary: number
  adwValue: number
  adwSource: 'ADW' | 'FALLBACK_MONTHLY' | 'NONE'
  adwWarnings: string[]
  // 年假結算（EO s.41D 按比例；未滿 3 個月 = 0 日）
  leave: {
    joinDate: Date
    serviceMonths: number
    earnedNow: number
    accrued: number
    used: number
    unused: number
    payout: number
  } | null
  cutoffStr: string
  settleByDate: string
  unusedDays: number
  leavePayout: number
  // 時間帳戶
  tb: {
    latestPeriod: string | null
    balanceMinutes: number
    debtMinutes: number
    debtDays: number
    entries: Array<{ date: Date; type: string; minutes: number; note: string | null }>
  }
  // ★ cwm-resigv3：當月工資（讀唔算 — 三段 fallback）
  monthWage: { source: 'payrollItem' | 'preview' | 'none'; basePay: number | null }
  // ★ 2026-09-30 [cwm-resignfull]：當月全部項目（引擎直算，用結算揀嘅勤工獎／店舖獎金）— 同月結同一條數。
  //   null = 算唔到（fallback 舊口徑：淨係 basePay）
  monthItems: ResignMonthItems | null
  // ★ cwm-resignfull：今次用緊嘅揀法 + 來源（settlement = 結算卡揀；payroll = 舊計糧單 carry）
  choices: {
    attendanceBonusOverride: BonusOverride | null          // 引擎實際用（null = 自動）
    attendanceBonusChoice: SettlementBonusChoice | null     // 結算卡揀（null = 冇揀 → 跟計糧單）
    attendanceBonusSource: 'settlement' | 'payroll' | null
    storeBonus: number | null
    storeBonusSource: 'settlement' | 'payroll' | null
  }
  // ★ 2026-09-06 [cwm-caldayratio]：受僱比例快照（分子 = 受僱曆日（含休息日，含頭含尾），分母 = 當月曆日數）— 結算寫入 monthWageRatio 用
  monthWageRatio: { value: number; numerator: number; denominator: number } | null
  // ★ 2026-09-30 [cwm-restdebt]：⑤ 超額休息日扣款（伺服器側單一來源 — 預填 + 引擎注入同口徑）
  //   改用休息日帳（REST_DAY LeaveBalance）截至最後工作日嘅透支 —— 之前月份預支得追、
  //   無薪假／生日假／空白日唔會雙重扣、同次序無關（RS-01/02/03/04）。
  excessRest: {
    entitledRestDays: number      // 截至最後工作日應得（已扣當月未做完部分）
    usedRestDays: number          // 截至最後工作日已用（休息日 + 換鐘）
    unearnedThisMonth: number     // 當月發放 × 未受僱曆日 ÷ 當月曆日
    excessDays: number
    monthlyRestGrantDays: number
    employedDays: number
    monthDays: number
    hasBalanceRow: boolean        // 冇 REST_DAY 帳 → false（UI 提示）
    prevYearRemaining: number | null  // 上年帳仍為負 → 顯示警告（RS-14）
    amount: number
  } | null
  /** ⑤ 預填扣款值（excessRest.amount；null → 0）— 拍板① */
  excessRestDeduction: number
  // ★ 2026-09-30 [cwm-restdebt] F8（RS-13）：預支年假／生日假（餘額 < 0）— 只顯示唔扣（EO s.32 可扣項要老細拍板）
  advanceLeave: { annual: number; birthday: number }
  // EO s.32 上限基底（★ v3：prorate 後當月工資 + 年假薪酬，唔再用全月薪）
  finalPeriodWage: number
  quarterCap: number
  halfCap: number
}

/**
 * @param prisma  DB client
 * @param empId   Employee id
 * @param lastDay 最後工作日 'YYYY-MM-DD'（HK）
 * @param noticeDays 通知日數（null = 尚未揀；只影響 noticePay 由 caller 計算）
 */
/**
 * ★ 2026-09-05 [cwm-resigv3] 當月工資【讀唔算】—— 金額永遠由引擎出，結算卡只顯示。
 * ① 該月計糧已生成 → 讀 PayrollItem.detailJson（權威；⚠️ detail.salary 係 object，
 *    數字喺 d?.salary?.basePay — 攞錯會顯示 [object Object]）
 * ② 未生成 → calculatePayrollWithRules 直算（同 payroll-runs/preview 同一來源；
 *    resign 兩 route 係 server 側，fetch preview API 會 requireAuth 401，嚴禁）
 * ③ 兩者都 fail（無薪酬規則／計算 error／該月無數據）→ none
 *    （前端確認掣 disabled；resign-settle route 側 400 攔截）
 */
export async function resolveMonthWage(
  prisma: PrismaClient,
  empId: string,
  periodMonth: string,
  clinicId: string | null,
  // ★ 2026-09-05 [cwm-resignroster]：離職預覽 lastDay（「最後工作日翌日 HK 午夜」口徑）—
  //   員工未辦理離職時 DB resignedAt = NULL，唔傳 override 引擎會當做足全月。
  resignedAtOverride?: Date,
  // ★ cwm-resignfull：caller 已經直算過（computeResignSettlement）→ 唔好再跑多次引擎
  precomputedDirect?: { basePay: number | null; ratioDetail: { value: number; numerator: number; denominator: number } | null },
): Promise<{ source: 'payrollItem' | 'preview' | 'none'; basePay: number | null; ratioDetail: { value: number; numerator: number; denominator: number } | null }> {
  // ★ 2026-09-05 [cwm-resignroster]：有 override 但 run 口徑唔配 preview lastDay 時，run 嘅數係舊嘅 → 跳過 ①。
  //   兩種 stale：(a) 員工未辦理離職（DB resignedAt = NULL → run 係全月 ratio 1）；
  //   (b) DB resignedAt 對應嘅最後工作日 ≠ 今次 lastDay（預覽/重結算咗另一日）。
  //   無 override（月底計糧等舊路徑）→ 行為零改動。
  let runStale = false
  if (resignedAtOverride) {
    try {
      const d = await prisma.employee.findUnique({ where: { id: empId }, select: { resignedAt: true } })
      const ovLastDay = toHKDateStr(new Date(resignedAtOverride.getTime() - 86400000))
      const dbLastDay = d?.resignedAt ? toHKDateStr(new Date(d.resignedAt.getTime() - 86400000)) : null
      runStale = dbLastDay === null || dbLastDay !== ovLastDay
    } catch { runStale = true /* 查唔到當 stale → ② */ }
  }
  if (!runStale) {
    // ① 已生成計糧單（權威）
    try {
      const monthDate = new Date(`${periodMonth}-01T00:00:00+08:00`)
      const { start: ms, end: me } = getMonthRange(monthDate)
      const item = await prisma.payrollItem.findFirst({
        where: { employeeId: empId, run: { periodMonth: { gte: ms, lte: me } } },
        select: { detailJson: true },
      })
      if (item?.detailJson) {
        const d = JSON.parse(item.detailJson)
        const bp = d?.salary?.basePay
        if (typeof bp === 'number' && Number.isFinite(bp)) {
          // ★ cwm-resignroster：老舊 run（fix 前生成）detailJson 無 employedRatioDetail → null
          const rd = d?.employedRatioDetail
          const ratioDetail = rd && typeof rd.value === 'number' && typeof rd.numerator === 'number' && typeof rd.denominator === 'number'
            ? { value: rd.value, numerator: rd.numerator, denominator: rd.denominator }
            : null
          return { source: 'payrollItem', basePay: bp, ratioDetail }
        }
      }
    } catch (e) {
      console.error('[resolveMonthWage] 讀 PayrollItem 失敗，fallback preview', e)
    }
  }

  // ② 引擎直算（fallback）
  const direct = precomputedDirect ?? await resolveMonthWageDirect(prisma, empId, periodMonth, clinicId, resignedAtOverride)
  if (direct.basePay != null) {
    return { source: 'preview', basePay: direct.basePay, ratioDetail: direct.ratioDetail }
  }

  // ③ 兩者都 fail
  return { source: 'none', basePay: null, ratioDetail: null }
}

/**
 * ★ 2026-09-05 [cwm-resignroster]：引擎直算（同 payroll-runs/preview route 取 config 方式一致 — 單一來源）。
 * 回 { basePay, ratioDetail }；basePay = null 表示算唔到（無薪酬規則／計算 error）。
 * resign-settle 嘅 monthWageRatio 快照直接調呢個（唔經 resolveMonthWage 嘅 ① fallback）—
 * 因為 snapshot 必須反映【今次確認嘅 lastDay】，而 run detailJson 嘅 ratio 係 DB resignedAt 口徑
 * （re-settle 改咗 lastDay 時會走樣）。
 */
async function resolveMonthWageDirect(
  prisma: PrismaClient,
  empId: string,
  periodMonth: string,
  clinicId: string | null,
  resignedAtOverride?: Date,
  // ★ cwm-resignfull：同 buildEngineOptions 同口徑（勤工獎覆蓋／店舖獎金／拆帳）— 唔傳離職結算項（結算卡另外加）
  engineOpts?: { attendanceBonusOverride?: BonusOverride | null; storeBonus?: number | null; splitPay?: number | null },
): Promise<{ basePay: number | null; ratioDetail: { value: number; numerator: number; denominator: number } | null; monthItems: ResignMonthItems | null }> {
  try {
    // ★ cwm-money P2-6：單一來源（active 覆蓋本月 → 退回經 POST 停用且有 effectiveTo 嘅舊規則）
    const { start: _rsMonthStart, end: _rsMonthEnd } = getMonthRange(new Date(`${periodMonth}-01T00:00:00+08:00`))
    const payRule = await findPayRuleForMonth(prisma, empId, _rsMonthStart, _rsMonthEnd)
    if (payRule?.configJson) {
      const config = JSON.parse(payRule.configJson)
      if (config.base_type || config.modifiers) {
        const monthDate = new Date(`${periodMonth}-01T00:00:00+08:00`)
        const hourly = config.base_type === 'hourly'
        const result = await calculatePayrollWithRules(empId, monthDate, clinicId, config, {
          resignedAtOverride,
          attendanceBonusOverride: engineOpts?.attendanceBonusOverride ?? null,
          // 同 buildEngineOptions：時薪冇店舖獎金／拆帳；店舖獎金 0 = 唔傳
          ...(!hourly && engineOpts?.storeBonus ? { storeBonus: engineOpts.storeBonus } : {}),
          ...(!hourly && engineOpts?.splitPay != null ? { splitPay: engineOpts.splitPay } : {}),
        })
        if (!result.error && typeof result.basePay === 'number' && Number.isFinite(result.basePay)) {
          const rd = (result.detail as any)?.employedRatioDetail
          const ratioDetail = rd && typeof rd.value === 'number' && typeof rd.numerator === 'number' && typeof rd.denominator === 'number'
            ? { value: rd.value, numerator: rd.numerator, denominator: rd.denominator }
            : null
          return { basePay: result.basePay, ratioDetail, monthItems: toMonthItems(result, hourly) }
        }
      }
    }
  } catch (e) {
    console.error('[resolveMonthWageDirect] calculatePayrollWithRules 失敗', e)
  }
  return { basePay: null, ratioDetail: null, monthItems: null }
}

/**
 * ★ 2026-09-30 [cwm-resignfull]：引擎結果 → 結算卡逐行（口徑同 engine grossPay 逐項式）。
 * otherAdjust = grossPay − 逐項 —— 正常係 0；將來引擎加新項目冇同步呢度，都唔會令加總走樣。
 */
export function toMonthItems(result: { basePay: number; otPay: number; splitPay: number | null; attendanceBonus: number; attendanceBonusReason?: string; deduction: number; detail: any }, hourly: boolean): ResignMonthItems {
  const d = result.detail ?? {}
  const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
  const basePay = r2(result.basePay)
  const attendanceBonus = r2(result.attendanceBonus)
  const otPay = r2(result.otPay)
  const splitPay = r2(result.splitPay ?? 0)
  const storeBonus = r2(d.storeBonus ?? 0)
  const allowances = r2(d.salary?.allowances ?? d.totalAllowances ?? 0)
  const deduction = r2(result.deduction)
  const sickDeduction = r2(d.sickDeduction ?? 0)
  const adwAdjustment = r2(d.adwAdjustment ?? 0)
  const maternityPay = r2(d.maternityPay ?? 0)
  const paternityPay = r2(d.paternityPay ?? 0)
  const grossPay = r2(d.grossPay ?? d.salary?.grossPay ?? basePay)
  const itemised = basePay + attendanceBonus + otPay + splitPay + storeBonus + allowances - deduction - sickDeduction + adwAdjustment + maternityPay + paternityPay
  const otherAdjust = Math.abs(grossPay - itemised) > 0.01 ? r2(grossPay - itemised) : 0
  let miscEntries: ResignMonthItems['miscEntries'] = []
  try {
    const arr = d.miscDetailJson ? JSON.parse(d.miscDetailJson) : []
    if (Array.isArray(arr)) miscEntries = arr.map((e: any) => ({ amount: r2(e?.amount), description: e?.description ?? null }))
  } catch { /* 壞 JSON → 只顯示總數 */ }
  return {
    payType: hourly ? 'HOURLY' : 'MONTHLY',
    basePay, attendanceBonus,
    attendanceBonusReason: result.attendanceBonusReason ?? d.attendanceBonusReason ?? null,
    otPay, splitPay, storeBonus, allowances, deduction, sickDeduction, adwAdjustment, maternityPay, paternityPay,
    otherAdjust, grossPay,
    miscAmount: r2(d.miscAmount ?? 0),
    miscEntries,
    // 同 engine：時薪 MPF 0；月薪 mpfRate 0 = 規則冇開 MPF
    mpfEnabled: !hourly && (Number(d.mpfRate) || 0) > 0,
  }
}

export async function computeResignSettlement(
  prisma: PrismaClient,
  empId: string,
  lastDay: string,
  noticeDays?: number | null,
  clinicId?: string | null,
  // ★ 2026-09-05 [cwm-resignroster]：預覽/結算嘅 lastDay（「最後工作日翌日 HK 午夜」）— 傳落引擎當 resignedAtOverride
  // ★ 2026-09-30 [cwm-resignfull]：attendanceBonusOverride／storeBonus = 結算卡揀（null/undefined = 跟舊計糧單）
  opts?: { resignedAtOverride?: Date; attendanceBonusOverride?: SettlementBonusChoice | null; storeBonus?: number | null },
): Promise<ResignSettlementCalc> {
  // ★ cutoff = 最後工作日**結束**（翌日 HK 午夜）—— 同 resign/route.ts `${lastDay}T16:00:00Z` 口徑一致
  const cutoff = new Date(hkDateStart(lastDay).getTime() + 86400000)
  const cutoffStr = lastDay

  const emp = await prisma.employee.findUnique({ where: { id: empId } })
  if (!emp) throw new Error('EMP_NOT_FOUND')

  // ★ 2026-09-30 [cwm-restdebt] RS-12：月薪用「最後工作日當月生效」嘅規則（同計糧 findPayRuleForMonth 同一來源）——
  //   舊版用「最新 active 規則」：離職前已停用規則 → 月薪 0 → ADW fallback 0 → 年假薪酬／超額扣款全 0；月中調薪 → 計錯
  const { start: _rsLastMonthStart, end: _rsLastMonthEnd } = getMonthRange(hkDateStart(lastDay))
  const payRule = await findPayRuleForMonth(prisma, empId, _rsLastMonthStart, _rsLastMonthEnd)
  let monthlySalary = 0
  try {
    monthlySalary = Number(JSON.parse(payRule?.configJson || '{}')?.monthly_salary) || 0
  } catch { /* 壞 JSON 當 0 */ }

  // ★ 拍板②：未放年假薪酬／代通知金一律用系統既有 Effective ADW
  let adwValue = 0
  let adwSource: 'ADW' | 'FALLBACK_MONTHLY' | 'NONE' = 'NONE'
  let adwWarnings: string[] = []
  try {
    const eff = await getEffectiveADW(prisma, empId, cutoff, monthlySalary)
    adwWarnings = eff.warnings
    if (eff.adw > 0) { adwValue = eff.adw; adwSource = 'ADW' }
  } catch (e) {
    console.error('[resign-settlement] getEffectiveADW failed, fallback monthly', e)
  }
  if (adwValue === 0 && monthlySalary > 0) {
    adwValue = Math.round((monthlySalary * 12 / 365) * 100) / 100
    adwSource = 'FALLBACK_MONTHLY'
  }

  // ★ 年假結算 —— 'prorata'（EO s.41D）；未滿 3 個月服務 = 0 日（EO s.41C）
  let leave: ResignSettlementCalc['leave'] = null
  let unusedDays = 0
  let leavePayout = 0
  // ★ 2026-09-30 [cwm-restdebt] F8（RS-13）：預支年假／生日假 — 只顯示唔扣（EO s.32 可扣項要老細拍板）
  const advanceLeave: { annual: number; birthday: number } = { annual: 0, birthday: 0 }
  if (emp.joinDate) {
    const annualType = await prisma.leaveType.findUnique({ where: { systemKey: LEAVE_SYSTEM_KEYS.ANNUAL } })
    const bal = annualType
      ? await prisma.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: { employeeId: empId, leaveTypeId: annualType.id, year: 0 },
          },
        })
      : null
    const usedRaw = bal?.used ?? 0
    // ★ 2026-09-30 [cwm-restdebt] RS-05/06：扣走最後工作日之後嘅已批年假（包括跨過離職日嘅部分）——
    //   結算同「確認離職」撳邊個先都一樣（同次序無關）；跨日假按曆日比例拆（純函數可獨立測）
    const lastDayEnd = hkDateEnd(lastDay)
    const future = annualType ? await prisma.leaveRequest.findMany({
      where: { employeeId: empId, leaveTypeId: annualType.id, status: 'APPROVED', endDate: { gt: lastDayEnd } },
      select: { startDate: true, endDate: true, days: true },
    }) : []
    const usedDays = Math.max(0, Math.round((usedRaw - futureAnnualLeaveDays(future, lastDay)) * 100) / 100)
    const s = settleLeaveOnResign(new Date(emp.joinDate), cutoff, monthlySalary, usedDays)
    unusedDays = s.unused
    leavePayout = Math.round(s.unused * adwValue * 100) / 100
    leave = {
      joinDate: emp.joinDate,
      serviceMonths: serviceMonths(new Date(emp.joinDate), cutoff),
      earnedNow: totalAccruedLeave(new Date(emp.joinDate), cutoff, 'earned'),
      accrued: s.accrued,
      used: s.used,
      unused: s.unused,
      payout: leavePayout,
    }
    // ★ 2026-09-30 [cwm-restdebt] F8（RS-13）：預支 = 餘額 < 0 嘅絕對值。
    //   年假用累積行（year 0）；生日假用最後工作日曆年行（NEGATIVE_ALLOWED_KEYS 准預支）。
    //   只顯示唔入任何金額 —— 追唔追涉及 EO s.32 可扣項目，由老闆決定（人手加時間帳戶扣除／同員工協議）。
    const annualRem = bal ? bal.entitled - bal.used : 0
    if (annualRem < 0) advanceLeave.annual = Math.round(-annualRem * 100) / 100
    const birthdayType = await prisma.leaveType.findUnique({ where: { systemKey: LEAVE_SYSTEM_KEYS.BIRTHDAY } })
    if (birthdayType) {
      const bBal = await prisma.leaveBalance.findUnique({
        where: { employeeId_leaveTypeId_year: { employeeId: empId, leaveTypeId: birthdayType.id, year: Number(lastDay.slice(0, 4)) } },
      })
      const bRem = bBal ? bBal.entitled - bBal.used : 0
      if (bRem < 0) advanceLeave.birthday = Math.round(-bRem * 100) / 100
    }
  }

  // ★ cwm-resigv3：當月工資（讀唔算；periodMonth = 最後工作日當月）
  // ★ cwm-resignroster：金額照「讀唔算」（run 權威）但必須帶 override — 預覽時 DB resignedAt 仲係 NULL，
  //   run 口徑對唔上 preview lastDay 時 resolveMonthWage 會自動跳過 ① 走引擎直算。
  //   ratio 快照另走引擎直算 + override（跟今次 lastDay）
  const periodMonth = lastDay.slice(0, 7)
  // ★ 2026-09-30 [cwm-resignfull]：揀法優先次序同 generatePayrollRun 一樣（結算卡 > 舊計糧單 carry）——
  //   結算卡顯示嘅當月數 = 重新生成計糧之後嘅數
  const { start: _pmStart, end: _pmEnd } = getMonthRange(new Date(`${periodMonth}-01T00:00:00+08:00`))
  const carriedItem = await prisma.payrollItem.findFirst({
    where: { employeeId: empId, run: { periodMonth: { gte: _pmStart, lte: _pmEnd } } },
    select: { storeBonus: true, splitPay: true, attendanceBonusOverride: true },
  })
  const carriedOverride: BonusOverride | null = carriedItem?.attendanceBonusOverride === 'FORCE_ON' || carriedItem?.attendanceBonusOverride === 'FORCE_OFF'
    ? carriedItem.attendanceBonusOverride : null
  const carriedStoreBonus = carriedItem?.storeBonus ? carriedItem.storeBonus : null
  const attendanceBonusOverride = toEngineBonusOverride(pickResignChoice<SettlementBonusChoice>(opts?.attendanceBonusOverride, null, carriedOverride))
  const storeBonus = pickResignChoice(opts?.storeBonus, null, carriedStoreBonus)
  const choices: ResignSettlementCalc['choices'] = {
    attendanceBonusOverride,
    attendanceBonusChoice: opts?.attendanceBonusOverride ?? null,
    attendanceBonusSource: opts?.attendanceBonusOverride != null ? 'settlement' : carriedOverride != null ? 'payroll' : null,
    storeBonus,
    storeBonusSource: opts?.storeBonus != null ? 'settlement' : carriedStoreBonus != null ? 'payroll' : null,
  }
  const ratioDirect = await resolveMonthWageDirect(prisma, empId, periodMonth, clinicId ?? null, opts?.resignedAtOverride, {
    attendanceBonusOverride, storeBonus, splitPay: carriedItem?.splitPay ?? null,
  })
  const monthWage = await resolveMonthWage(prisma, empId, periodMonth, clinicId ?? null, opts?.resignedAtOverride, ratioDirect)
  const monthItems = ratioDirect.monthItems

  // ★ 2026-09-30 [cwm-restdebt]：超額休息日 = 休息日帳截至最後工作日嘅透支（見 settlement-utils calcRestDayDebt）
  //   時薪唔發休息日（grant-restdays:52）→ 唔計
  let excessRest: ResignSettlementCalc['excessRest'] = null
  let excessRestDeduction = 0
  // ★ 2026-09-30 [cwm-restdebt] RS-12：isHourly 同月薪同一來源（最後工作日當月規則）
  const isHourly = payRule?.payType === 'HOURLY'
  if (emp.joinDate && !isHourly) {
    const { start: mStart, end: mEnd } = getMonthRange(hkDateStart(lastDay))
    const periodStart = emp.joinDate > mStart ? new Date(emp.joinDate) : new Date(mStart)
    const periodEnd = hkDateStart(lastDay)
    const employedDays = countHKDaysInclusive(periodStart, periodEnd)
    const monthDays = hkDaysInMonth(periodEnd)
    const [balMap, grants, prevBalMap] = await Promise.all([
      restDayBalanceAsOf(prisma, [empId], lastDay),
      prisma.timeBankEntry.findMany({
        where: { employeeId: empId, type: 'RESTDAY_GRANT', date: { gte: mStart, lte: mEnd } },
        select: { minutes: true },
      }),
      restDayBalanceAsOf(prisma, [empId], `${Number(lastDay.slice(0, 4)) - 1}-12-31`),
    ])
    const bal = balMap.get(empId) ?? null
    const monthlyRestGrantDays = Math.round((grants.reduce((s, g) => s + g.minutes, 0) / 1440) * 100) / 100
    const d = calcRestDayDebt({
      entitledAsOf: bal?.entitled ?? 0,
      usedAsOf: bal?.used ?? 0,
      monthlyRestGrantDays, employedDays, monthDays, monthlySalary,
    })
    const prev = prevBalMap.get(empId)
    excessRest = {
      ...d, monthlyRestGrantDays, employedDays, monthDays,
      hasBalanceRow: bal != null,
      prevYearRemaining: prev && prev.remaining < 0 ? prev.remaining : null,
    }
    excessRestDeduction = excessRest.amount
  }

  // ★ 時間帳戶：欠款提示 + 上限（EO s.32）
  const tbRows = await prisma.timeBank.findMany({
    where: { employeeId: empId },
    orderBy: { periodMonth: 'desc' },
    take: 36,
  })
  const cutoffMonth = cutoffStr.slice(0, 7)
  const tbLatest = tbRows.find(r => periodMonthKey(r.periodMonth) <= cutoffMonth) ?? null
  let tbBalance = tbLatest?.balance ?? 0
  // ★ E-10：raw TimeBank row 可能係舊快取 —— S3 之後部分路徑（例如改更次扣飯鐘、raw SQL）只靠 cacheKey 失配，唔會刪 row。
  //   驗 key；唔夾就即場重算嗰個月（同 engine 同一口徑：規則按月 + negative_carry），degraded 就唔准出數。
  if (tbLatest) {
    const { start: tbMonthStart, end: tbMonthEnd } = getMonthRange(tbLatest.periodMonth)
    const freshKey = await timeBankCacheKey(prisma, empId, tbMonthEnd, tbMonthStart)
    if (tbLatest.cacheKey !== freshKey) {
      const tbRule = await findPayRuleForMonth(prisma, empId, tbMonthStart, tbMonthEnd)
      let tbCfg: any = {}
      try { tbCfg = JSON.parse(tbRule?.configJson || '{}') } catch { /* 壞 JSON 當冇 config */ }
      // 同 payroll-engine.ts:3897 timeBankConfig 口徑：{ negative_carry: 'reset', ...modifiers.time_bank }
      const fresh = await calculateTimeBank(empId, tbMonthStart, { negative_carry: 'reset', ...(tbCfg?.modifiers?.time_bank ?? {}) }, prisma)
      if ((fresh as any).degraded) throw new Error('時間帳戶讀取失敗，離職結算暫停，請重試')
      tbBalance = fresh.balance
    }
  }
  const tbDebt = tbBalance < 0 ? -tbBalance : 0
  const tbDebtDays = Math.round((tbDebt / TIMEBANK_MINUTES_PER_DAY) * 100) / 100 // 9 小時工作日 = 1 日
  const tbEntries = tbDebt > 0
    ? await prisma.timeBankEntry.findMany({
        where: { employeeId: empId, minutes: { lt: 0 } },
        orderBy: { date: 'desc' },
        take: 10,
        select: { date: true, type: true, minutes: true, note: true },
      })
    : []

  // ★ cwm-resigv3 #8（生死格）：上限基底 = prorate 後當月工資（讀引擎）+ 未放年假薪酬。
  //   source='none' 時 fallback 回全月薪（前端確認掣 disabled + route 400 攔截）。
  //   用全月薪會令月中離職嘅 1/4 上限高估 2.7 倍 → 可能扣超法定上限。
  // ★ 2026-09-30 [cwm-resignfull]：當月 Gross（連勤工獎／OT／津貼／店舖獎金、扣咗缺勤）先係「該工資期工資」；
  //   算唔到先退返 basePay（舊口徑）
  const finalPeriodWage = Math.round(((monthItems?.grossPay ?? monthWage.basePay ?? monthlySalary) + leavePayout) * 100) / 100
  const quarterCap = Math.round((finalPeriodWage / 4) * 100) / 100
  const halfCap = Math.round((finalPeriodWage / 2) * 100) / 100

  // ★ EO s.25：終止合約後 7 日內須付清
  const [sy, sm, sd] = cutoffStr.split('-').map(Number)
  const settleByDate = new Date(Date.UTC(sy, sm - 1, sd + 7)).toISOString().slice(0, 10)

  void noticeDays // 通知金由 caller 以 adwValue × noticeDays 計算（同 preview 口徑）

  return {
    monthlySalary,
    adwValue,
    adwSource,
    adwWarnings,
    leave,
    cutoffStr,
    settleByDate,
    unusedDays,
    leavePayout,
    tb: {
      latestPeriod: tbLatest ? periodMonthKey(tbLatest.periodMonth) : null,
      balanceMinutes: tbBalance,
      debtMinutes: tbDebt,
      debtDays: tbDebtDays,
      entries: tbEntries as ResignSettlementCalc['tb']['entries'],
    },
    monthWage,
    monthItems,
    choices,
    // ★ cwm-resignroster：比例快照（跟今次 lastDay 引擎直算；時薪/算唔到 → null）
    monthWageRatio: ratioDirect.ratioDetail,
    // ★ cwm-excessrest：⑤ 超額休息日扣款（預填 = 計算值；拍板①）
    excessRest,
    excessRestDeduction,
    advanceLeave,
    finalPeriodWage,
    quarterCap,
    halfCap,
  }
}

/** 代通知金 = ADW × 通知日數（拍板③；noticeDays null → null） */
export function calcNoticePay(adwValue: number, noticeDays: number | null): number | null {
  if (noticeDays == null) return null
  return Math.round(adwValue * noticeDays * 100) / 100
}

/** 時間帳戶欠款換算（MD §五）：tbDays = |tbMinutes| ÷ 9 小時工作日（2 位小數）× 今日 ADW */
// ★ cwm-resigv3：純函數搬去 settlement-utils.ts（client-safe）— 轉發保持舊 import 路徑
export { calcTimebankDebtAmount, prefillTbDeduction } from './settlement-utils'
