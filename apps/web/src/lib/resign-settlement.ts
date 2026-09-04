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
import { hkDateStart, toHKDateStr, periodMonthKey, getMonthRange } from './hk-date'
import { calculatePayrollWithRules } from './payroll-engine'
import { settleLeaveOnResign, totalAccruedLeave, serviceMonths } from './leave-calculation'
import { LEAVE_SYSTEM_KEYS } from './leave-types'
import { getEffectiveADW } from './adw'

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
): Promise<{ source: 'payrollItem' | 'preview' | 'none'; basePay: number | null }> {
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
        return { source: 'payrollItem', basePay: bp }
      }
    }
  } catch (e) {
    console.error('[resolveMonthWage] 讀 PayrollItem 失敗，fallback preview', e)
  }

  // ② 引擎直算（同 payroll-runs/preview route 取 config 方式一致 — 單一來源）
  try {
    const payRule = await prisma.payRule.findFirst({
      where: { employeeId: empId, isActive: true },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    })
    if (payRule?.configJson) {
      const config = JSON.parse(payRule.configJson)
      if (config.base_type || config.modifiers) {
        const monthDate = new Date(`${periodMonth}-01T00:00:00+08:00`)
        const result = await calculatePayrollWithRules(empId, monthDate, clinicId, config)
        if (!result.error && typeof result.basePay === 'number' && Number.isFinite(result.basePay)) {
          return { source: 'preview', basePay: result.basePay }
        }
      }
    }
  } catch (e) {
    console.error('[resolveMonthWage] calculatePayrollWithRules 失敗，fallback none', e)
  }

  // ③ 兩者都 fail
  return { source: 'none', basePay: null }
}

export async function computeResignSettlement(
  prisma: PrismaClient,
  empId: string,
  lastDay: string,
  noticeDays?: number | null,
  clinicId?: string | null,
): Promise<ResignSettlementCalc> {
  // ★ cutoff = 最後工作日**結束**（翌日 HK 午夜）—— 同 resign/route.ts `${lastDay}T16:00:00Z` 口徑一致
  const cutoff = new Date(hkDateStart(lastDay).getTime() + 86400000)
  const cutoffStr = lastDay

  const emp = await prisma.employee.findUnique({
    where: { id: empId },
    include: {
      payRules: {
        where: { isActive: true },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 1,
      },
    },
  })
  if (!emp) throw new Error('EMP_NOT_FOUND')

  let monthlySalary = 0
  try {
    const cfg = JSON.parse(emp.payRules[0]?.configJson || '{}')
    monthlySalary = Number(cfg?.monthly_salary) || 0
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
  if (emp.joinDate) {
    const annualType = await prisma.leaveType.findUnique({ where: { systemKey: LEAVE_SYSTEM_KEYS.ANNUAL } })
    const bal = annualType
      ? await prisma.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: { employeeId: empId, leaveTypeId: annualType.id, year: 0 },
          },
        })
      : null
    const usedDays = bal?.used ?? 0
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
  }

  // ★ cwm-resigv3：當月工資（讀唔算；periodMonth = 最後工作日當月）
  const periodMonth = lastDay.slice(0, 7)
  const monthWage = await resolveMonthWage(prisma, empId, periodMonth, clinicId ?? null)

  // ★ 時間帳戶：欠款提示 + 上限（EO s.32）
  const tbRows = await prisma.timeBank.findMany({
    where: { employeeId: empId },
    orderBy: { periodMonth: 'desc' },
    take: 36,
  })
  const cutoffMonth = cutoffStr.slice(0, 7)
  const tbLatest = tbRows.find(r => periodMonthKey(r.periodMonth) <= cutoffMonth) ?? null
  const tbBalance = tbLatest?.balance ?? 0
  const tbDebt = tbBalance < 0 ? -tbBalance : 0
  const tbDebtDays = Math.round((tbDebt / 540) * 100) / 100 // 540 分 = 9 小時工作日
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
  const finalPeriodWage = Math.round(((monthWage.basePay ?? monthlySalary) + leavePayout) * 100) / 100
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

/** 時間帳戶欠款換算（MD §五）：tbDays = |tbMinutes| / 540（2 位小數）× 今日 ADW */
// ★ cwm-resigv3：純函數搬去 settlement-utils.ts（client-safe）— 轉發保持舊 import 路徑
export { calcTimebankDebtAmount, prefillTbDeduction } from './settlement-utils'
