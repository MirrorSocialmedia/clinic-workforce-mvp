export const dynamic = 'force-dynamic'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeResignSettlement, calcNoticePay, calcTimebankDebtAmount } from '@/lib/resign-settlement'
import { addDaysStr, hkDateOnly, hkTodayStr, toHKDateStr } from '@/lib/hk-date'

/**
 * POST /api/employees/[id]/resign-settle — 確認離職結算，寫入 ResignSettlement 表
 *
 * ★ 2026-09-04 [cwm-resigpay-20260904]（MD §六）：
 * - OWNER-only + payroll_generate（requirePerm；非 OWNER 403）
 * - 全部數伺服器側重算（同 resign-preview 同一 lib）—— 前端數字唔可信
 * - EO s.32 上限伺服器側再驗：tbDeduction > 該工資期工資/4 → 400
 *   （前端 disabled 繞得過；非法扣除工資最高罰 10 萬 + 監禁 1 年）
 * - ★ 2026-09-05 [cwm-resigv3]：
 *   - 時機守衛：lastDay > 今日（HKT）→ 400（當月考勤未齊，當月工資會計少）
 *   - 結算 JSON 帶 monthWage 快照（讀引擎；source='none' → 400 攔截）
 * - ★ 2026-09-11 [cwm-resignflow-20260911]：
 *   - 結算搬去獨立 ResignSettlement 表（唔使等該月計糧生成、冇打卡都結算到）
 *   - 同一 transaction 同步寫 Employee.status/leaveDate/resignedAt + User.status（停用帳號）
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
  const { lastDay, noticeDays, tbDeduction, excessDeduction } = body

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
  // ★ 2026-09-07 [cwm-excessrest]：⑤ 超額休息日扣款（拍板② 歸類 s.32(2)(a) 缺勤扣除 — 唔受 s.32 1/4 上限；
  //   拍板①：body 冇傳/傳 null → 用伺服器計算值（預填口徑）。≥ 0 驗證。）
  let excessDeductionVal: number | null = null
  if (excessDeduction != null) {
    if (typeof excessDeduction !== 'number' || !Number.isFinite(excessDeduction) || excessDeduction < 0) {
      return NextResponse.json({ error: 'excessDeduction 必須 ≥ 0' }, { status: 400 })
    }
    excessDeductionVal = Math.round(excessDeduction * 100) / 100
  }

  // ── 伺服器側重算（同 preview 同一 lib）─────────────────
  let calc
  // ★ 2026-09-05 [cwm-resignroster]：cutoff = 最後工作日翌日 HK 午夜（同 resign/route.ts:29 口徑）
  const cutoffDate = new Date(`${lastDay}T16:00:00Z`)
  try {
    calc = await computeResignSettlement(prisma, empId, lastDay, undefined, undefined, { resignedAtOverride: cutoffDate })
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

  // 時間帳戶換算（MD §五）：|tbMinutes| ÷ 9 小時工作日 日 × 今日 ADW
  const { tbAmount } = calcTimebankDebtAmount(calc.tb.balanceMinutes, calc.adwValue)

  // ── 寫入 ResignSettlement（cwm-resignflow-20260911 A3/B1）──────────
  // ★ A3：唔再需要 PayrollRun／PayrollItem —— 結算有自己張表。
  //   舊設計要等計糧生成先結算到，同 EO s.25「7 日內付清」衝突。
  const periodMonth = lastDay.slice(0, 7)

  // ★ 2026-09-05 [cwm-resignroster] 拍板③a：改最後工作日 → 重新確認結算，直接覆蓋同一筆，
  //   但要 audit 記低變更（唔准「改咗最後工作日但用舊 ratio」）— 舊值改由新表讀
  let lastDayChangeNote = ''
  const prev = await prisma.resignSettlement.findUnique({ where: { employeeId: empId } })
  const prevLastDay = prev ? toHKDateStr(prev.lastDay) : null
  if (prevLastDay && prevLastDay !== lastDay) {
    lastDayChangeNote = `｜最後工作日由 ${prevLastDay} 改為 ${lastDay}，ratio 重算`
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
    // ★ 2026-09-07 [cwm-excessrest]：⑤ 超額休息日扣款（MPF 之前；拍板① 預填 = 計算值）
    excessRestDeduction: excessDeductionVal ?? calc.excessRestDeduction,
    excessRest: calc.excessRest,
    quarterCap: calc.quarterCap,
    adwUsed: calc.adwValue,
    // ★ cwm-resigv3：當月工資快照（讀引擎 — 月底計糧注入時展示／審計用；金額以快照為準）
    monthWage: { source: calc.monthWage.source, basePay: calc.monthWage.basePay },
    // ★ 2026-09-06 [cwm-caldayratio]：受僱比例快照（分子 = 受僱曆日（含休息日），分母 = 當月曆日數）
    monthWageRatio: calc.monthWageRatio
      ? { ...calc.monthWageRatio, lastDay, computedAt: new Date().toISOString() }
      : null,
    settledAt: new Date().toISOString(),
    settledBy: auth.session.userId,
  }

  // ★ B1：結算 + 員工狀態 + 停用帳號 + audit —— 四樣同一個 interactive transaction
  //   （結算寫咗但狀態冇寫，就係之前嘅亂源）
  const lastDayDate = hkDateOnly(lastDay)                         // 9/9 00:00+08:00 = 最後工作日
  const effectiveDate = hkDateOnly(addDaysStr(lastDay, 1))        // 9/10 — resignedAt 語義 = 最後工作日 + 1（唔准改）

  const emp = await prisma.employee.findUnique({
    where: { id: empId },
    select: { id: true, userId: true, status: true },
  })
  if (!emp) return NextResponse.json({ error: '員工不存在' }, { status: 404 })

  const settlementData = {
    noticeDays,
    noticePay: noticePay ?? 0,   // noticeDays 上面已驗證必係 number → 實踐上必有值；欄 non-null
    annualLeaveDays: calc.unusedDays,
    annualLeavePay: calc.leavePayout,
    tbMinutes: calc.tb.balanceMinutes,
    tbAmount,
    tbDeduction: tbDeductionVal,
    excessRestDeduction: settlement.excessRestDeduction,
    quarterCap: calc.quarterCap,
    adwUsed: calc.adwValue,
    detailJson: JSON.stringify(settlement),   // 同舊 resignSettlementJson 同結構（過渡對照用）
    settledBy: auth.session.userId,
  }

  const settlementId = await prisma.$transaction(async (tx) => {
    // ① 結算（upsert —— 改最後工作日 = 覆蓋同一筆；periodMonth 跟住變 → 舊月自動冇、新月自動有）
    const row = await tx.resignSettlement.upsert({
      where: { employeeId: empId },
      create: { employeeId: empId, lastDay: lastDayDate, periodMonth, ...settlementData },
      update: { lastDay: lastDayDate, periodMonth, ...settlementData, settledAt: new Date() },
    })

    // ② 員工狀態：leaveDate = 最後工作日；resignedAt = 生效日 = 最後工作日 + 1（語義唔准改）
    await tx.employee.update({
      where: { id: empId },
      data: { status: 'RESIGNED', leaveDate: lastDayDate, resignedAt: effectiveDate },
    })

    // ③ ★★★ 帳號停用 —— login/route.ts:71 驗 User.status，唔寫呢句佢照樣登入到
    await tx.user.update({ where: { id: emp.userId }, data: { status: 'RESIGNED' } })

    // ④ audit
    await tx.auditLog.create({
      data: {
        actorId: auth.session.userId,
        action: 'EMPLOYEE_RESIGN_SETTLE',
        entity: 'ResignSettlement',
        entityId: row.id,
        targetEmployeeId: empId,
        notes: `離職結算：lastDay=${lastDay}, noticeDays=${noticeDays}, noticePay=${noticePay}, 年假=${calc.unusedDays}日/$${calc.leavePayout}, tb=${calc.tb.balanceMinutes}分/扣${tbDeductionVal ?? 0}, 超額休息日=${calc.excessRest?.excessDays ?? 0}日/扣${settlement.excessRestDeduction ?? 0}, ADW=${calc.adwValue}${lastDayChangeNote}｜已同步標記離職 + 停用帳號`,
        ipAddress: null,
        userAgent: null,
      } as any,
    })
    return row.id
  })

  return NextResponse.json({ ok: true, settlementId, settlement })
}
