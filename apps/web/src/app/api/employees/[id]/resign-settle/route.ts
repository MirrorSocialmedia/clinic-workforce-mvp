export const dynamic = 'force-dynamic'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeResignSettlement, calcNoticePay, calcTimebankDebtAmount } from '@/lib/resign-settlement'
import { getMonthRange, hkTodayStr } from '@/lib/hk-date'

/**
 * POST /api/employees/[id]/resign-settle — 確認離職結算，寫入 PayrollItem.resignSettlementJson
 *
 * ★ 2026-09-04 [cwm-resigpay-20260904]（MD §六）：
 * - OWNER-only + payroll_generate（requirePerm；非 OWNER 403）
 * - 全部數伺服器側重算（同 resign-preview 同一 lib）—— 前端數字唔可信
 * - EO s.32 上限伺服器側再驗：tbDeduction > 該工資期工資/4 → 400
 *   （前端 disabled 繞得過；非法扣除工資最高罰 10 萬 + 監禁 1 年）
 * - ★ 2026-09-05 [cwm-resigv3]：
 *   - 時機守衛：lastDay > 今日（HKT）→ 400（當月考勤未齊，當月工資會計少）
 *   - 結算 JSON 帶 monthWage 快照（讀引擎；source='none' → 400 攔截）
 *   - 月底計糧讀呢份 JSON 注入（payroll-engine MPF_INCLUDE_SETTLEMENT）
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requirePerm(req, 'payroll_generate')
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') // ROLE-OK：結算涉及寫入薪金
    return NextResponse.json({ error: '僅老闆可確認離職結算' }, { status: 403 })

  const resolvedParams = await params
  const empId = resolvedParams.id

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'body 必填 (JSON)' }, { status: 400 })
  const { lastDay, noticeDays, tbDeduction } = body

  // ── 驗證 ──────────────────────────────────────────────
  if (typeof lastDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastDay) || isNaN(Date.parse(`${lastDay}T00:00:00+08:00`))) {
    return NextResponse.json({ error: 'lastDay (YYYY-MM-DD) 必填' }, { status: 400 })
  }
  // ★ cwm-resigv3 時機守衛（MD §4.4 #19）：最後工作日未到 → 當月考勤未齊，
  //   當月工資（讀引擎 prorate）會計少 → 唔可以確認結算。
  if (lastDay > hkTodayStr()) {
    return NextResponse.json(
      { error: `最後工作日 ${lastDay} 未到，當月考勤未齊，唔可以確認結算` },
      { status: 400 },
    )
  }
  if (typeof noticeDays !== 'number' || !Number.isFinite(noticeDays) || noticeDays < 0 || noticeDays > 365) {
    return NextResponse.json({ error: 'noticeDays（0-365 整數）必填' }, { status: 400 })
  }
  let tbDeductionVal: number | null = null
  if (tbDeduction != null) {
    if (typeof tbDeduction !== 'number' || !Number.isFinite(tbDeduction) || tbDeduction < 0) {
      return NextResponse.json({ error: 'tbDeduction 必須 ≥ 0' }, { status: 400 })
    }
    tbDeductionVal = Math.round(tbDeduction * 100) / 100
  }

  // ── 伺服器側重算（同 preview 同一 lib）─────────────────
  let calc
  try {
    calc = await computeResignSettlement(prisma, empId, lastDay)
  } catch (e: any) {
    if (e?.message === 'EMP_NOT_FOUND') return NextResponse.json({ error: '員工不存在' }, { status: 404 })
    throw e
  }

  const noticePay = calcNoticePay(calc.adwValue, noticeDays)

  // ★ cwm-resigv3：攞唔到當月工資（無該月計糧 + 引擎直算失敗）→ 唔俾寫入冇工資嘅結算
  if (calc.monthWage.source === 'none') {
    return NextResponse.json(
      { error: '攞唔到當月工資 — 請先生成該月計糧' },
      { status: 400 },
    )
  }

  // ★★★ EO s.32 上限伺服器側再驗（前端 disabled 繞得過）
  if (tbDeductionVal != null && tbDeductionVal > calc.quarterCap) {
    return NextResponse.json(
      { error: `超過法定上限 $${calc.quarterCap.toFixed(2)}` },
      { status: 400 },
    )
  }

  // 時間帳戶換算（MD §五）：|tbMinutes|/540 日 × 今日 ADW
  const { tbAmount } = calcTimebankDebtAmount(calc.tb.balanceMinutes, calc.adwValue)

  // ── 寫入 PayrollItem（最後工作日當月嘅計糧單）───────────
  const periodMonth = lastDay.slice(0, 7)
  const monthDate = new Date(`${periodMonth}-01T00:00:00+08:00`)
  const { start: ms, end: me } = getMonthRange(monthDate)
  const run = await prisma.payrollRun.findFirst({
    where: { periodMonth: { gte: ms, lte: me } },
    select: { id: true, status: true },
  })
  if (!run) {
    return NextResponse.json(
      { error: `${periodMonth} 計糧單未生成 —— 請先生成該月計糧` },
      { status: 409 },
    )
  }
  const item = await prisma.payrollItem.findUnique({
    where: { runId_employeeId: { runId: run.id, employeeId: empId } },
    select: { id: true },
  })
  if (!item) {
    return NextResponse.json(
      { error: '呢個員工唔喺該月計糧單入面（該月無打卡／排更？）' },
      { status: 409 },
    )
  }

  const settlement = {
    lastDay: lastDay,
    noticeDays: noticeDays,
    noticePay: noticePay,
    annualLeaveDays: calc.unusedDays,
    annualLeavePay: calc.leavePayout,
    tbMinutes: calc.tb.balanceMinutes,
    tbAmount: tbAmount,
    tbDeduction: tbDeductionVal,
    quarterCap: calc.quarterCap,
    adwUsed: calc.adwValue,
    // ★ cwm-resigv3：當月工資快照（讀引擎 — 月底計糧注入時展示／審計用；金額以快照為準）
    monthWage: { source: calc.monthWage.source, basePay: calc.monthWage.basePay },
    settledAt: new Date().toISOString(),
    settledBy: auth.session.userId,
  }

  await prisma.$transaction([
    prisma.payrollItem.update({
      where: { id: item.id },
      data: { resignSettlementJson: JSON.stringify(settlement) },
    }),
    prisma.auditLog.create({
      data: {
        actorId: auth.session.userId,
        action: 'EMPLOYEE_RESIGN_SETTLE',
        entity: 'PayrollItem',
        entityId: item.id,
        targetEmployeeId: empId,
        notes: `離職結算：lastDay=${lastDay}, noticeDays=${noticeDays}, noticePay=${noticePay}, 年假=${calc.unusedDays}日/$${calc.leavePayout}, tb=${calc.tb.balanceMinutes}分/扣${tbDeductionVal ?? 0}, ADW=${calc.adwValue}, run=${run.id}`,
        ipAddress: null,
        userAgent: null,
      } as any,
    }),
  ])

  return NextResponse.json({ ok: true, runId: run.id, itemId: item.id, settlement })
}
