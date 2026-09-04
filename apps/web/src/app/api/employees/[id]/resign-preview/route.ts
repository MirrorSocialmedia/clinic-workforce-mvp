export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { settleLeaveOnResign, totalAccruedLeave, serviceMonths } from '@/lib/leave-calculation'
import { hkDateStart, periodMonthKey } from '@/lib/hk-date'
import { LEAVE_SYSTEM_KEYS } from '@/lib/leave-types'
import { getEffectiveADW } from '@/lib/adw'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') // ROLE-OK：離職結算涉及薪金，限 OWNER
    return NextResponse.json({ error: '僅老闆可查看' }, { status: 403 })

  const resolvedParams = await params
  const empId = resolvedParams.id
  const lastDay = new URL(req.url).searchParams.get('lastDay')
  if (!lastDay)
    return NextResponse.json({ error: 'lastDay 必填' }, { status: 400 })

  // ★ cwm-resigsettle-20260904：cutoff = 最後工作日**結束**（翌日 HK 午夜）—— 同 resign/route.ts
  //   `${lastDay}T16:00:00Z` 口徑一致，結算計足最後一日。回應入面嘅 lastDay/settleByDate
  //   照樣用原 lastDay 字串（唔好 cutoffStr）。
  const cutoff = new Date(hkDateStart(lastDay).getTime() + 86400000)
  const cutoffStr = lastDay

  const [emp, futureShifts, futureLeaves] = await Promise.all([
    prisma.employee.findUnique({
      where: { id: empId },
      include: {
        user: { select: { name: true } },
        payRules: {
          where: { isActive: true },
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
          take: 1,
        },
      },
    }),
    prisma.shift.count({
      where: {
        employeeId: empId,
        date: { gte: cutoff },
        status: { not: 'CANCELLED' },
      },
    }),
    prisma.leaveRequest.count({
      where: {
        employeeId: empId,
        startDate: { gte: cutoff },
        status: 'APPROVED',
      },
    }),
  ])

  if (!emp) return NextResponse.json({ error: '員工不存在' }, { status: 404 })

  let monthlySalary = 0
  try {
    const cfg = JSON.parse(emp.payRules[0]?.configJson || '{}')
    monthlySalary = Number(cfg?.monthly_salary) || 0
  } catch { /* 壞 JSON 當 0 */ }

  // ★ 2026-09-02 cwm-resigsettle-20260904 拍板②：
  //   未放年假薪酬／代通知金一律用系統既有 Effective ADW（唔係月薪÷30）。
  //   ADW 冇足夠歷史數據時 fallback 月薪×12÷365（同 adw.ts 警告文字口徑一致）。
  let adwValue = 0
  let adwSource: 'ADW' | 'FALLBACK_MONTHLY' | 'NONE' = 'NONE'
  let adwWarnings: string[] = []
  try {
    const eff = await getEffectiveADW(prisma, empId, cutoff, monthlySalary)
    adwWarnings = eff.warnings
    if (eff.adw > 0) { adwValue = eff.adw; adwSource = 'ADW' }
  } catch (e) {
    console.error('[resign-preview] getEffectiveADW failed, fallback monthly', e)
  }
  if (adwValue === 0 && monthlySalary > 0) {
    adwValue = Math.round((monthlySalary * 12 / 365) * 100) / 100
    adwSource = 'FALLBACK_MONTHLY'
  }

  // ★ 年假結算 —— 用 'prorata'（EO s.41D：離職時未完成年度按比例）
  //   未滿 3 個月服務 = 0 日（EO s.41C，settleLeaveOnResign 已處理 — Selina 場景）
  let leaveSettlement: any = null
  let leavePayout = 0
  let unusedDays = 0
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
    // ★ 拍板②：未放年假薪酬 = 未放日數 × Effective ADW
    leavePayout = Math.round(s.unused * adwValue * 100) / 100

    leaveSettlement = {
      joinDate: emp.joinDate,
      serviceMonths: serviceMonths(new Date(emp.joinDate), cutoff),
      earnedNow: totalAccruedLeave(new Date(emp.joinDate), cutoff, 'earned'),
      accrued: s.accrued,
      used: s.used,
      unused: s.unused,
      monthlySalary,
      dailyWage: adwValue, // ★ Effective ADW（舊：月薪×12÷365 推算）
      payout: leavePayout,  // ★ = 未放日數 × ADW
      isEstimate: adwValue === 0,
      adwSource,
    }
  }

  // ★ 拍板③：通知期人手輸入（已做足/7日/1個月/自訂），系統唔自動推導。
  //   代通知金 = ADW × 通知日數（唔係月薪÷30）。
  const noticeDaysRaw = new URL(req.url).searchParams.get('noticeDays')
  let noticeDays: number | null = null
  if (noticeDaysRaw !== null) {
    const nd = Number(noticeDaysRaw)
    if (Number.isFinite(nd) && nd >= 0 && nd <= 365) noticeDays = nd
  }
  const noticePay = noticeDays != null ? Math.round(adwValue * noticeDays * 100) / 100 : null

  // ★ 拍板②：時間帳戶欠款只顯示提示 + 法例上限，系統唔自動扣（EO s.32）
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
  // 該工資期工資（預估）= 月薪 + 未放年假薪酬 —— 上限計算基底（MD §二 CC2 實算口徑）
  const finalPeriodWage = Math.round(((monthlySalary || 0) + leavePayout) * 100) / 100
  const quarterCap = Math.round((finalPeriodWage / 4) * 100) / 100
  const halfCap = Math.round((finalPeriodWage / 2) * 100) / 100

  // ★ EO s.25：終止合約後 7 日內須付清
  const [sy, sm, sd] = cutoffStr.split('-').map(Number)
  const settleByDate = new Date(Date.UTC(sy, sm - 1, sd + 7)).toISOString().slice(0, 10)

  const settlement = {
    lastDay: cutoffStr,
    settleByDate,
    adw: { value: adwValue, source: adwSource, warnings: adwWarnings },
    unusedLeave: { days: unusedDays, dailyWage: adwValue, payout: leavePayout },
    notice: {
      days: noticeDays, // null = 尚未揀（人手輸入）
      pay: noticePay,   // = ADW × 通知日數
      options: [0, 7, 30],
      allowCustom: true,
      hint: '⚠️ 按【合約】填，唔係按 EO 最低。EO 只定下限。',
    },
    timebank: {
      latestPeriod: tbLatest ? periodMonthKey(tbLatest.periodMonth) : null,
      balanceMinutes: tbBalance,
      debtMinutes: tbDebt,
      debtDays: tbDebtDays,
      entries: tbEntries,
      caps: { finalPeriodWage, quarter: quarterCap, half: halfCap },
      deduction: null, // ★ 空白，人手輸入 —— 系統唔自動填（拍板②）
      deductionNote: 'EO s.32：單項扣除唔得超過該工資期工資 1/4，扣除總額唔得超過 1/2。金額由人手填寫，系統唔自動填。',
    },
    // ★ 休息日（REST_DAY）係法定權利（EO s.17），唔顯示喺結算單、唔換錢（MD §4.3）
    excludedFromSettlement: ['REST_DAY'],
  }

  return NextResponse.json({ futureShifts, futureApprovedLeaves: futureLeaves, leaveSettlement, settlement })
}
