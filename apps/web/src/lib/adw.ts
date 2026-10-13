import { PrismaClient } from '@prisma/client'
import { toHKDateStr, periodMonthKey } from './hk-date'

export interface ADWSource {
  periodMonth: string
  source: 'PayrollItem' | 'WageHistory'
  wage: number
  excludedDays: number
  excludedWage: number
  calendarDays: number
}

export interface ADWResult {
  adw: number
  totalWage: number
  totalDays: number
  isShortPeriod: boolean
  periodStart: string
  periodEnd: string
  sources: ADWSource[]
  warnings: string[]
}

/**
 * Calculate EO 713 Average Daily Wage.
 *
 * Legal basis (Labour Department Employment Ordinance Guide):
 * - Use the 12 months before the specified date
 * - If employed < 12 months, use the shorter period
 * - Exclude periods without full wages (rest days, holidays, annual leave,
 *   sick leave, maternity, paternity, work injury, agreed leave, days without work)
 *   along with payments made during those periods
 *
 * @param db PrismaClient instance
 * @param employeeId Employee ID
 * @param specifiedDate The specified date (first day of leave / sick leave / maternity leave)
 */
export async function calculateADW(
  db: PrismaClient,
  employeeId: string,
  specifiedDate: Date,
): Promise<ADWResult> {
  const warnings: string[] = []

  // 1) Get employee join date
  const employee = await db.employee.findUnique({
    where: { id: employeeId },
    select: { joinDate: true },
  })
  if (!employee) throw new Error(`Employee ${employeeId} not found`)

  // 2) Determine calculation period:
  //    periodEnd = specifiedDate - 1 day (in HK time)
  //    12 months before specifiedDate
  //    Use the longer of joinDate vs 12-months-ago as periodStart
  const periodEndStr = toHKDateStr(specifiedDate)
  const [endY, endM, endD] = periodEndStr.split('-').map(Number)
  const periodEnd = new Date(Date.UTC(endY, endM - 1, endD - 1)) // day before specified date

  const twelveMonthsAgo = new Date(periodEnd)
  twelveMonthsAgo.setUTCFullYear(twelveMonthsAgo.getUTCFullYear() - 1)

  const joinDate = new Date(employee.joinDate)
  const joinDateHK = toHKDateStr(joinDate)
  const joinUTC = new Date(Date.UTC(
    parseInt(joinDateHK.split('-')[0]),
    parseInt(joinDateHK.split('-')[1]) - 1,
    parseInt(joinDateHK.split('-')[2]),
  ))

  const isShortPeriod = joinUTC > twelveMonthsAgo
  const periodStart = isShortPeriod ? joinUTC : twelveMonthsAgo

  if (isShortPeriod) {
    warnings.push(
      `受僱不足12個月，以較短期間計算（自 ${joinDateHK} 起）`,
    )
  }

  // ★ 指定日喺入職當月/次月時，periodStart 會大過 periodEnd（區間倒轉），
  //   startMonth > endMonth 令查詢永遠 0 筆 → adw 0 → 引擎靜靜 fallback。
  if (periodStart > periodEnd) {
    warnings.push(
      `入職日（${joinDateHK}）在計算期間之後，無足夠歷史資料計算 ADW。` +
      `系統將以「月薪 × 12 ÷ 365」推算日薪。`,
    )
    return {
      adw: 0, totalWage: 0, totalDays: 0, isShortPeriod: true,
      periodStart: toHKDateStr(periodStart),
      periodEnd: toHKDateStr(periodEnd),
      sources: [], warnings,
    }
  }

  // 3) Convert to YYYY-MM month strings
  const startMonth = toHKDateStr(periodStart).slice(0, 7)
  const endMonth = toHKDateStr(periodEnd).slice(0, 7)

  // ★ PayrollRun.periodMonth 係 DateTime（寫入時係 HK 月初午夜），
  //   唔可以同 "YYYY-MM" 字串比較 —— 舊寫法會令 Prisma 擲 ValidationError，
  //   令整個 ADW 靜靜 fallback 去「月薪 × 12 ÷ 365」。
  //   前後各留 2 日緩衝（兜返早期可能以 UTC 午夜寫入嘅資料），之後再按 pmStr 精準過濾。
  const runFrom = new Date(
    new Date(`${startMonth}-01T00:00:00+08:00`).getTime() - 2 * 86400000,
  )
  const nextOfEnd = (() => {
    const [ey, em] = endMonth.split('-').map(Number)
    const ny = em === 12 ? ey + 1 : ey
    const nm = em === 12 ? 1 : em + 1
    return `${ny}-${String(nm).padStart(2, '0')}`
  })()
  const runTo = new Date(
    new Date(`${nextOfEnd}-01T00:00:00+08:00`).getTime() + 2 * 86400000,
  )

  // 4) Fetch PayrollItem + WageHistory for the period
  const [payrollItems, wageHistories] = await Promise.all([
    db.payrollItem.findMany({
      where: {
        employeeId,
        // ★ cwm-empoverview-20261014（老闆拍板）：只用已確認（FINALIZED／EXPORTED）計糧 —— 草稿數字未定，唔計入 ADW
        run: { periodMonth: { gte: runFrom, lt: runTo }, status: { in: ADW_RUN_STATUSES } }, // ★ Date vs Date
      },
      include: { run: { select: { periodMonth: true } } },
    }),
    db.wageHistory.findMany({
      where: { employeeId, periodMonth: { gte: startMonth, lte: endMonth } },
    }),
  ])

  // 5) Merge: PayrollItem takes priority over WageHistory for same month
  const byMonth = new Map<string, ADWSource>()

  for (const wh of wageHistories) {
    byMonth.set(wh.periodMonth, {
      periodMonth: wh.periodMonth,
      source: 'WageHistory',
      wage: wh.totalWage,
      excludedDays: wh.excludedDays,
      excludedWage: wh.excludedWage,
      calendarDays: wh.calendarDays,
    })
  }

  for (const pi of payrollItems) {
    const pm = (pi.run as { periodMonth: Date | string }).periodMonth
    const pmStr = periodMonthKey(pm)
    // ★ 上面用咗 ±2 日緩衝，可能多拉咗前後一個月，喺呢度精準剔走
    if (pmStr < startMonth || pmStr > endMonth) continue
    byMonth.set(pmStr, {
      periodMonth: pmStr,
      source: 'PayrollItem',
      // ★ `??` 唔接 0 → 歷史資料（eoWage 全 0）會直接當 0 工資，令 ADW 被拉低。
      //   改用 `||` 讓 deriveEoWage() 兜返歷史單，等 backfill 做完先可以改返 `??`
      wage: payrollItemEoWage(pi),
      excludedDays: (pi as any).excludedDays ?? 0,
      excludedWage: (pi as any).excludedWage ?? 0,
      calendarDays: daysInMonth(pmStr),
    })
  }

  const sources = [...byMonth.values()].sort((a, b) =>
    a.periodMonth.localeCompare(b.periodMonth),
  )

  // 6) Data completeness check
  const expectedMonths = monthsBetween(startMonth, endMonth)
  if (sources.length < expectedMonths) {
    warnings.push(
      `期間應有 ${expectedMonths} 個月資料，實際只有 ${sources.length} 個月。` +
      `ADW 可能不準確，建議在「歷史工資」補錄缺少的月份。`,
    )
  }

  // 7) Calculate ADW (numerator and denominator both deduct exclusions)
  const totalWage = sources.reduce((s, x) => s + x.wage - x.excludedWage, 0)
  const totalDays = sources.reduce((s, x) => s + x.calendarDays - x.excludedDays, 0)

  if (totalDays <= 0) {
    warnings.push('可計算日數為 0，無法計算 ADW')
    return {
      adw: 0,
      totalWage: 0,
      totalDays: 0,
      isShortPeriod,
      periodStart: toHKDateStr(periodStart),
      periodEnd: toHKDateStr(periodEnd),
      sources,
      warnings,
    }
  }

  return {
    adw: Math.round((totalWage / totalDays) * 100) / 100,
    totalWage: Math.round(totalWage * 100) / 100,
    totalDays,
    isShortPeriod,
    periodStart: toHKDateStr(periodStart),
    periodEnd: toHKDateStr(periodEnd),
    sources,
    warnings,
  }
}

/**
 * Derive EO wage from PayrollItem when eoWage field is not yet populated.
 *
 * EO wage definition: base pay + OT pay + split pay + store bonus + attendance bonus
 *   minus deductions.
 *   Excludes: misc reimbursement (not wages), employer MPF contributions.
 */
export function deriveEoWage(pi: any): number {
  const attendanceBonus = (() => {
    try {
      const detail = pi.detailJson ? JSON.parse(pi.detailJson) : {}
      return detail.attendanceBonus ?? 0
    } catch {
      return 0
    }
  })()

  return (
    (pi.basePay ?? 0) +
    (pi.otPay ?? 0) +
    (pi.splitPay ?? 0) +
    (pi.storeBonus ?? 0) +
    attendanceBonus -
    (pi.deduction ?? 0)
  )
}

/** ★ cwm-empoverview-20261014：計糧行嘅 EO 工資（ADW 同員工總覽「工資歷史」共用，唔好兩邊各自計） */
export function payrollItemEoWage(pi: any): number {
  // ★ `??` 唔接 0 → 歷史資料（eoWage 全 0）會直接當 0 工資；用 `||` 讓 deriveEoWage() 兜返歷史單
  return pi.eoWage || deriveEoWage(pi)
}

/** ★ cwm-empoverview-20261014：ADW 只用呢啲狀態嘅計糧（草稿唔計） */
export const ADW_RUN_STATUSES: Array<'FINALIZED' | 'EXPORTED'> = ['FINALIZED', 'EXPORTED']

export interface WageHistoryRow {
  periodMonth: string
  /** PAYROLL = 已確認計糧（ADW 用）；HISTORY = 歷史工資（匯入／補錄）；DRAFT = 計糧草稿（唔計 ADW） */
  source: 'PAYROLL' | 'HISTORY' | 'DRAFT'
  totalWage: number
  excludedDays: number
  excludedWage: number
  calendarDays: number
}

/** 純函數：同一個月優先次序 已確認計糧 ＞ 歷史工資 ＞ 草稿（同 calculateADW 一致：計糧蓋過歷史工資，草稿唔計） */
export function mergeWageHistory(
  manual: Array<{ periodMonth: string; totalWage: number; excludedDays: number; excludedWage: number; calendarDays: number }>,
  items: Array<{ periodMonth: string; status: string; wage: number; excludedDays: number; excludedWage: number }>,
  fromMonth: string, toMonth: string,
): WageHistoryRow[] {
  const rank = { PAYROLL: 3, HISTORY: 2, DRAFT: 1 } as const
  const by = new Map<string, WageHistoryRow>()
  const put = (r: WageHistoryRow) => {
    if (r.periodMonth < fromMonth || r.periodMonth > toMonth) return
    const cur = by.get(r.periodMonth)
    if (!cur || rank[r.source] > rank[cur.source]) by.set(r.periodMonth, r)
  }
  for (const w of manual) put({ periodMonth: w.periodMonth, source: 'HISTORY', totalWage: w.totalWage, excludedDays: w.excludedDays, excludedWage: w.excludedWage, calendarDays: w.calendarDays })
  for (const it of items) put({
    periodMonth: it.periodMonth,
    source: (ADW_RUN_STATUSES as string[]).includes(it.status) ? 'PAYROLL' : 'DRAFT',
    totalWage: Math.round(it.wage * 100) / 100,
    excludedDays: it.excludedDays, excludedWage: it.excludedWage, calendarDays: daysInMonth(it.periodMonth),
  })
  return [...by.values()].sort((a, b) => b.periodMonth.localeCompare(a.periodMonth))
}

/** ★ cwm-empoverview-20261014：員工總覽「工資歷史（ADW 來源）」—— 歷史工資＋系統計糧（以前淨係讀歷史工資） */
export async function wageHistoryRows(db: any, employeeId: string, fromMonth: string, toMonth: string): Promise<WageHistoryRow[]> {
  const [manual, items] = await Promise.all([
    db.wageHistory.findMany({ where: { employeeId, periodMonth: { gte: fromMonth, lte: toMonth } } }),
    db.payrollItem.findMany({
      where: {
        employeeId,
        run: { periodMonth: { gte: new Date(`${fromMonth}-01T00:00:00+08:00`), lt: new Date(new Date(`${toMonth}-01T00:00:00+08:00`).getTime() + 32 * 86400000) } },
      },
      select: {
        eoWage: true, excludedDays: true, excludedWage: true, detailJson: true,
        basePay: true, otPay: true, splitPay: true, storeBonus: true, deduction: true,
        run: { select: { periodMonth: true, status: true } },
      },
    }),
  ])
  return mergeWageHistory(manual, items.map((it: any) => ({
    periodMonth: periodMonthKey(it.run.periodMonth), status: it.run.status, wage: payrollItemEoWage(it),
    excludedDays: it.excludedDays ?? 0, excludedWage: it.excludedWage ?? 0,
  })), fromMonth, toMonth)
}

/** Days in a month from YYYY-MM string */
export function daysInMonth(periodMonth: string): number {
  const [y, m] = periodMonth.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Number of months between two YYYY-MM strings (inclusive) */
function monthsBetween(start: string, end: string): number {
  const [sy, sm] = start.split('-').map(Number)
  const [ey, em] = end.split('-').map(Number)
  return (ey - sy) * 12 + (em - sm) + 1
}

/**
 * 攞「可以直接用嚟計錢」嘅 ADW —— 已套用薪金調整政策。
 * ★ 除非你真係要原始條例值做審計比較，否則一律用呢個，唔好直接叫 calculateADW()。
 */
export async function getEffectiveADW(
  db: PrismaClient,
  employeeId: string,
  atDate: Date,
  monthlySalary: number,
  policy?: { floor_at_current_salary?: boolean; cap_at_current_salary?: boolean },
): Promise<ADWResult & AdwPolicyResult> {
  const raw = await calculateADW(db, employeeId, atDate)
  const policied = applyAdwPolicy(raw.adw, monthlySalary, policy)
  return { ...raw, ...policied }
}

/**
 * 計糧確認時的工資快照。
 *
 * ★ 唔會重算任何數值 —— 引擎生成時已經寫好 eoWage / excludedDays / excludedWage
 *   舊版喺呢度用另一套公式覆蓋，令「生成時啱、確認後錯」：
 *     · eoWage 包含 storeBonus（同決定相反）
 *     · excludedDays 包含休息日／公眾假期配額（月薪員工嗰啲係有薪，唔應剔除）
 *   單一計算來源 = 引擎。呢度只負責驗證 + 審計留痕。
 */
export async function snapshotWagesForADW(
  tx: any,
  runId: string,
  actorId: string,
): Promise<void> {
  const run = await tx.payrollRun.findUnique({
    where: { id: runId },
    include: {
      items: {
        select: {
          id: true,
          employeeId: true,
          eoWage: true,
          excludedDays: true,
          excludedWage: true,
          detailJson: true,
        },
      },
    },
  })
  if (!run) return

  const pmStr = typeof run.periodMonth === 'string'
    ? run.periodMonth
    : toHKDateStr(run.periodMonth).slice(0, 7)

  // ★ QA30: 判斷「引擎有冇計過」而唔係「值係咪 0」——
  //   eoWage = 0 可以係完全合法（時薪員工當月冇返工、全月無薪假），
  //   舊版寫法會令呢啲 run 永遠確認唔到，而且提示叫人「重新生成」形成死循環。
  const notComputed = run.items.filter((i: any) => {
    if (!i.detailJson) return true
    try {
      const d = JSON.parse(i.detailJson)
      return d.eoWage === undefined  // 引擎新版一定會寫呢個 key
    } catch {
      return true
    }
  })
  if (notComputed.length > 0) {
    // ★ cwm-money P2-2：訊息改準（計算失敗同舊版都會入呢度）
    throw new Error(
      `有 ${notComputed.length} 位員工計算失敗或者係舊版計糧（糧單入面金額為 0 嗰幾行），請修正後重新生成`,
    )
  }

  await tx.auditLog.create({
    data: {
      actorId,
      action: 'WAGE_SNAPSHOT',
      entity: 'PayrollRun',
      entityId: runId,
      afterJson: JSON.stringify({
        periodMonth: pmStr,
        itemCount: run.items.length,
        totalEoWage: run.items.reduce((s: number, i: any) => s + (i.eoWage ?? 0), 0),
      }),
      notes: `計糧確認：${pmStr} 共 ${run.items.length} 位員工，EO 工資已鎖定供 ADW 計算`,
    },
  })
}

// ------------------------------------------------------------------
// ADW Salary Adjustment Policy
// ------------------------------------------------------------------

export type AdwPolicyResult = {
  adw: number
  adwRaw: number
  policyApplied: 'none' | 'floor' | 'cap'
  currentEquivalent: number
}

/**
 * 套用薪金調整政策之後嘅有效 ADW。
 *
 * currentEquivalent = 月薪 × 12 ÷ 365
 * = 假設過去 12 個月都係現薪、冇剔除期間時 ADW 應有嘅值
 *
 * ⚠️ cap 可能令支付低於 EO 第 41 條嘅法定最低（ADW × 4/5）——
 *    只喺取得法律意見之後才好啟用。
 */
export function applyAdwPolicy(
  rawAdw: number,
  monthlySalary: number,
  policy?: { floor_at_current_salary?: boolean; cap_at_current_salary?: boolean },
): AdwPolicyResult {
  const currentEquivalent = (monthlySalary * 12) / 365
  let adw = rawAdw
  let policyApplied: 'none' | 'floor' | 'cap' = 'none'

  if (policy?.floor_at_current_salary && policy?.cap_at_current_salary) {
    console.warn(
      '[adw_policy] floor 同 cap 同時開啟 → ADW 永遠等於現薪等值，' +
      '12 個月回溯機制完全失效。請確認係咪有意如此。',
    )
  }

  if (policy?.floor_at_current_salary && adw < currentEquivalent) {
    adw = currentEquivalent
    policyApplied = 'floor'
  }
  if (policy?.cap_at_current_salary && adw > currentEquivalent) {
    adw = currentEquivalent
    policyApplied = 'cap'
  }

  return {
    adw: Math.round(adw * 100) / 100,
    adwRaw: Math.round(rawAdw * 100) / 100,
    policyApplied,
    currentEquivalent: Math.round(currentEquivalent * 100) / 100,
  }
}
