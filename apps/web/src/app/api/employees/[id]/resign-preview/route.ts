export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { canSeeConfidential } from '@/lib/scope-helpers'
import { computeResignSettlement, calcNoticePay } from '@/lib/resign-settlement'
import { hkDateStart, toHKDateStr } from '@/lib/hk-date'
import type { SettlementBonusChoice } from '@/lib/settlement-utils'

// ROLE-OK 更新：離職結算預覽 — OWNER + MANAGER（拍板 B：MANAGER 睇得到預覽；
// 寫入 resign-settle 仍然 OWNER-only + payroll_generate）
const PREVIEW_ROLES = ['OWNER', 'MANAGER']

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  if (!PREVIEW_ROLES.includes(auth.session.role))
    return NextResponse.json({ error: '僅老闆／經理可查看' }, { status: 403 })

  const resolvedParams = await params
  const empId = resolvedParams.id
  const lastDay = new URL(req.url).searchParams.get('lastDay')
  if (!lastDay)
    return NextResponse.json({ error: 'lastDay 必填' }, { status: 400 })
  // ★ 2026-09-30 [cwm-restdebt] RS-18：格式驗證 —— 舊版 lastDay=abc → hkDateStart throw → 500
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay))
    return NextResponse.json({ error: 'lastDay 必須係 YYYY-MM-DD' }, { status: 400 })

  // ★ cwm-p0sec-20260917：保密員工 —— 預覽含薪金，一律 403（同一個 canSeeConfidential helper）
  const empConf = await prisma.employee.findUnique({
    where: { id: empId },
    select: { payConfidential: true, homeClinicId: true },
  })
  if (!empConf) return NextResponse.json({ error: '員工不存在' }, { status: 404 })
  if (!(await canSeeConfidential(auth.session, auth.perms ?? [], empConf))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ★ cwm-resigsettle-20260904：cutoff = 最後工作日**結束**（翌日 HK 午夜）—— 同 resign/route.ts
  //   `${lastDay}T16:00:00Z` 口徑一致，結算計足最後一日。
  const cutoff = new Date(hkDateStart(lastDay).getTime() + 86400000)

  // ★ 2026-09-30 [cwm-resignfull]：勤工獎／店舖獎金揀法
  //   query 冇帶 → 用已確認結算嘅揀法（重開結算卡唔會「忘記」）；帶 '' → 跟計糧單；帶值 → 用佢
  const sp = new URL(req.url).searchParams
  const bonusRaw = sp.get('bonus')
  const storeBonusRaw = sp.get('storeBonus')
  if (bonusRaw != null && !['', 'AUTO', 'FORCE_ON', 'FORCE_OFF'].includes(bonusRaw))
    return NextResponse.json({ error: 'bonus 必須係 AUTO / FORCE_ON / FORCE_OFF' }, { status: 400 })
  let storeBonusVal: number | null = null
  if (storeBonusRaw != null && storeBonusRaw !== '') {
    const n = Number(storeBonusRaw)
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000)
      return NextResponse.json({ error: 'storeBonus 必須 ≥ 0' }, { status: 400 })
    storeBonusVal = Math.round(n * 100) / 100
  }
  const existing = await prisma.resignSettlement.findUnique({
    where: { employeeId: empId },
    select: { lastDay: true, noticeDays: true, tbDeduction: true, excessRestDeduction: true, settledAt: true, detailJson: true },
  })
  let saved: { attendanceBonusOverride: SettlementBonusChoice | null; storeBonus: number | null } = { attendanceBonusOverride: null, storeBonus: null }
  try {
    const d = existing?.detailJson ? JSON.parse(existing.detailJson) : null
    saved = {
      attendanceBonusOverride: ['AUTO', 'FORCE_ON', 'FORCE_OFF'].includes(d?.attendanceBonusOverride) ? d.attendanceBonusOverride : null,
      storeBonus: typeof d?.storeBonus === 'number' && Number.isFinite(d.storeBonus) ? d.storeBonus : null,
    }
  } catch { /* 壞 JSON → 當冇揀 */ }
  const bonusChoice: SettlementBonusChoice | null = bonusRaw == null ? saved.attendanceBonusOverride
    : bonusRaw === '' ? null : bonusRaw as SettlementBonusChoice
  const storeBonusChoice = storeBonusRaw == null ? saved.storeBonus : storeBonusVal

  try {
    const [futureShifts, futureLeaves, calc] = await Promise.all([
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
      computeResignSettlement(prisma, empId, lastDay, undefined, undefined, {
        resignedAtOverride: cutoff, attendanceBonusOverride: bonusChoice, storeBonus: storeBonusChoice,
      }),
    ])

    // 通知期人手輸入（拍板③）
    const noticeDaysRaw = new URL(req.url).searchParams.get('noticeDays')
    let noticeDays: number | null = null
    if (noticeDaysRaw !== null) {
      const nd = Number(noticeDaysRaw)
      if (Number.isFinite(nd) && nd >= 0 && nd <= 365) noticeDays = nd
    }
    const noticePay = calcNoticePay(calc.adwValue, noticeDays)

    const leaveSettlement = calc.leave ? {
      joinDate: calc.leave.joinDate,
      serviceMonths: calc.leave.serviceMonths,
      earnedNow: calc.leave.earnedNow,
      accrued: calc.leave.accrued,
      used: calc.leave.used,
      unused: calc.leave.unused,
      monthlySalary: calc.monthlySalary,
      dailyWage: calc.adwValue, // ★ Effective ADW
      payout: calc.leave.payout,  // ★ = 未放日數 × ADW
      isEstimate: calc.adwValue === 0,
      adwSource: calc.adwSource,
    } : null

    const settlement = {
      lastDay: calc.cutoffStr,
      monthlySalary: calc.monthlySalary, // ★ 2026-09-04：離職結算書 PDF 顯示用（實際出糧以計糧單 prorate 為準）
      // ★ cwm-resigv3：當月工資（讀唔算 — 三段 fallback）；card/PDF 三態顯示 + 確認掣 disabled 用
      monthWage: calc.monthWage,
      // ★ 2026-09-30 [cwm-resignfull]：當月全部項目（勤工獎／OT／津貼／店舖獎金／扣減／雜項）+ 揀法 — 同月結同一條數
      monthItems: calc.monthItems,
      choices: calc.choices,
      advanceLeave: calc.advanceLeave,
      // ★ cwm-resignfull：已確認結算（重開時預填最後工作日／通知期／扣款）
      existing: existing ? {
        lastDay: toHKDateStr(existing.lastDay),
        noticeDays: existing.noticeDays,
        tbDeduction: existing.tbDeduction == null ? null : Number(existing.tbDeduction),
        excessRestDeduction: existing.excessRestDeduction == null ? null : Number(existing.excessRestDeduction),
        settledAt: existing.settledAt,
      } : null,
      // ★ 2026-09-06 [cwm-caldayratio]：受僱比例快照（結算卡顯示「受僱 X 日（含休息日）÷ 當月 Y 日」做證明；老舊 run → null）
      monthWageRatio: calc.monthWageRatio,
      // ★ 2026-09-07 [cwm-excessrest]：⑤ 超額休息日扣款（伺服器計算；預填 = 計算值，拍板①）
      excessRest: calc.excessRest,
      excessRestDeduction: calc.excessRestDeduction,
      settleByDate: calc.settleByDate,
      adw: { value: calc.adwValue, source: calc.adwSource, warnings: calc.adwWarnings },
      unusedLeave: { days: calc.unusedDays, dailyWage: calc.adwValue, payout: calc.leavePayout },
      notice: {
        days: noticeDays, // null = 尚未揀（人手輸入）
        pay: noticePay,   // = ADW × 通知日數
        options: [0, 7, 30],
        allowCustom: true,
        hint: '⚠️ 按【合約】填，唔係按 EO 最低。EO 只定下限。',
      },
      timebank: {
        latestPeriod: calc.tb.latestPeriod,
        balanceMinutes: calc.tb.balanceMinutes,
        debtMinutes: calc.tb.debtMinutes,
        debtDays: calc.tb.debtDays,
        entries: calc.tb.entries,
        caps: { finalPeriodWage: calc.finalPeriodWage, quarter: calc.quarterCap, half: calc.halfCap },
        deduction: null, // ★ 空白（伺服器唔代填）— 前端預填 min(欠款, 1/4 上限) 仍可改（cwm-resigv3 拍板②）
        deductionNote: 'EO s.32：單項扣除唔得超過該工資期工資 1/4，扣除總額唔得超過 1/2。預填 min(欠款, 上限)，仍可人手修改。',
      },
      // ★ 休息日（REST_DAY）係法定權利（EO s.17），唔顯示喺結算單、唔換錢（MD §4.3）
      excludedFromSettlement: ['REST_DAY'],
    }

    return NextResponse.json({ futureShifts, futureApprovedLeaves: futureLeaves, leaveSettlement, settlement })
  } catch (e: any) {
    if (e?.message === 'EMP_NOT_FOUND') {
      return NextResponse.json({ error: '員工不存在' }, { status: 404 })
    }
    console.error('[resign-preview] error', e)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
