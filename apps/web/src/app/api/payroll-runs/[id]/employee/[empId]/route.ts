export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope, canSeeConfidential } from '@/lib/scope-helpers'
import { getMonthRange, periodMonthKey, toHKDateStr, hkDaysInMonth, addDaysStr } from '@/lib/hk-date'
import { estimateScheduledHours } from '@/lib/shift-punch-match'
// ★ cwm-tbcache-rosterdiff-20260909 D3：TimeBank 快取被 invalidate 後要現場重算（同 getCarriedFrom backfill 同語義）
import { calculateTimeBank, persistTimeBank } from '@/lib/payroll-engine'

// GET /api/payroll-runs/[id]/employee/[empId] — Single employee payroll detail
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; empId: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const item = await prisma.payrollItem.findUnique({
    where: { runId_employeeId: { runId: params.id, employeeId: params.empId } },
    include: {
      run: {
        include: {
          clinic: {
            select: {
              id: true,
              name: true,
              company: { select: { name: true, logoData: true, legalName: true } },
            },
          },
        },
      },
      employee: {
        select: {
          payConfidential: true,
          homeClinicId: true,
          user: { select: { id: true, name: true, phone: true, fullName: true } },
          clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
          payRules: { where: { isActive: true }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }], take: 1 },
        },
      },
    },
  })

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // ★ 診所範圍檢查 —— 唔可以用 assertClinicAccess（佢對 scope='self' 一律 403，
  //   令靠 payroll_* 權限放行嘅 EMPLOYEE 入唔到）。
  //   改用 resolveClinicScope：OWNER/MANAGER → null（全公司）、
  //   有權限嘅 EMPLOYEE → [主屬店]。（2026-08-03）
  // ★ Cross-clinic guard (2026-08-03): 被限制範圍嘅人唔可以查看跨店計糧單
  const allowedClinics = await resolveClinicScope(session, auth.perms ?? [], {
    homeOnly: ['payroll_view', 'payroll_generate'],
  })
  if (allowedClinics !== null) {
    if (!item.run?.clinicId) {
      return NextResponse.json({ error: '你冇權限查看跨店計糧單' }, { status: 403 })
    }
    if (!allowedClinics.includes(item.run.clinicId)) {
      return NextResponse.json({ error: '你冇權限查看呢間診所嘅計糧單' }, { status: 403 })
    }
  }

  // ★ 保密判斷（訊息要同診所範圍分開）
  const emp = { payConfidential: item.employee.payConfidential, homeClinicId: item.employee.homeClinicId }
  if (!(await canSeeConfidential(session, auth.perms ?? [], emp))) {
    return NextResponse.json({ error: '此員工薪資已設保密' }, { status: 403 })
  }

  const detail = item.detailJson ? JSON.parse(item.detailJson) : null

  const periodStart = new Date(item.run.periodMonth)
  const { end: periodEnd } = getMonthRange(periodStart)

  const punches = await prisma.punchRecord.findMany({
    where: { employeeId: params.empId, punchTime: { gte: periodStart, lte: periodEnd }, void: { is: null } },
    include: { clinic: { select: { id: true, name: true, shortName: true } } },
    orderBy: { punchTime: 'asc' },
    take: 100,
  })

  const leaves = await prisma.leaveRequest.findMany({
    where: {
      employeeId: params.empId, status: 'APPROVED',
      startDate: { lte: periodEnd }, endDate: { gte: periodStart },
    },
    include: { leaveType: { select: { name: true, isPaid: true, systemKey: true } } },
  })

  const corrections = await prisma.punchCorrection.findMany({
    where: {
      employeeId: params.empId, status: 'APPROVED',
      correctedTime: { gte: periodStart, lte: periodEnd },
    },
    orderBy: { correctedTime: 'asc' },
  })

  // ★ 2026-08-15: 編更差額資料（改用 estimateScheduledHours 扣午飯）
  const [shifts, payRules] = await Promise.all([
    prisma.shift.findMany({
      where: { employeeId: params.empId, date: { gte: periodStart, lte: periodEnd }, status: { not: 'CANCELLED' } },
      select: { employeeId: true, date: true, startTime: true, endTime: true, status: true, template: { select: { deductLunch: true } } },
    }),
    prisma.payRule.findMany({
      where: { employeeId: params.empId, isActive: true },
      select: { employeeId: true, configJson: true },
    }),
  ])

  // ★ Build lunch minutes map from PayRule config
  const lunchMinutesMap = new Map<string, number>()
  for (const r of payRules) {
    try {
      const cfg = JSON.parse(r.configJson || '{}')
      lunchMinutesMap.set(r.employeeId, cfg?.modifiers?.lunch_break?.defaultMinutes ?? 60)
    } catch {
      lunchMinutesMap.set(r.employeeId, 60)
    }
  }

  // 取 APPROVED 假期（去重）
  const periodStartStr = toHKDateStr(periodStart)
  const periodEndStr = toHKDateStr(periodEnd)
  const leaveDates = new Set<string>()
  for (const lr of leaves) {
    let d = toHKDateStr(lr.startDate)
    const end = toHKDateStr(lr.endDate)
    while (d <= end) {
      if (d >= periodStartStr && d <= periodEndStr) leaveDates.add(d)
      d = addDaysStr(d, 1)
    }
  }

  const daysInMonth = hkDaysInMonth(periodStart)
  const expectedMinutes = (daysInMonth - leaveDates.size) * 9 * 60 // 9h default

  const leaveDateSet = new Set(
    Array.from(leaveDates).map(d => `${params.empId}:${d}`)
  )

  const perDay = estimateScheduledHours(shifts as any, id => lunchMinutesMap.get(id) ?? 60)
  let rosterSpanMinutes = 0
  for (const [, days] of perDay) {
    for (const d of days) {
      if (leaveDateSet.has(`${params.empId}:${d.date}`)) continue
      rosterSpanMinutes += d.hours * 60
    }
  }
  rosterSpanMinutes = Math.round(rosterSpanMinutes)

  // ★ cwm-tbcache-rosterdiff-20260909 D1：時間帳戶明細要見到人手 entry。
  //   只攞【影響時間帳戶餘額】嘅 type —— RESTDAY_GRANT 係假期發放（另一本帳），
  //   夾硬列出嚟會令逐行加總對唔到餘額。ROSTER_DIFF 必須即時查（唔可以由 detailJson 攞 —
  //   佢凍結喺 finalize 寫 ROSTER_DIFF 之前）。
  const TB_DISPLAY_TYPES = [
    'MAKEUP', 'LEAVE_CONVERT', 'LEAVE_SWAP_BACK', 'INIT_ADJUST', 'REST_TO_ACCOUNT', 'ROSTER_DIFF',
  ]
  const manualEntries = await prisma.timeBankEntry.findMany({
    where: {
      employeeId: params.empId,
      type: { in: TB_DISPLAY_TYPES },
      date: { gte: periodStart, lte: periodEnd },
    },
    select: { employeeId: true, date: true, type: true, targetType: true, minutes: true, note: true },
    orderBy: [{ date: 'asc' }],
  })

  // ★ cwm-tbcache-rosterdiff-20260909 D3：對數行嘅「餘額」要用【live 時間帳戶】——
  //   detailJson 喺 generate 時凍結，永遠冇自己嗰筆 ROSTER_DIFF（問題二）；
  //   finalize 會 invalidate 快取 → 冇 row 就現場重算＋寫回（「下次讀重算」同語義）。
  let liveTb: { balance: number; carriedFrom: number } | null = null
  try {
    const tbRow = await prisma.timeBank.findFirst({
      where: { employeeId: params.empId, periodMonth: { gte: periodStart, lte: periodEnd } },
      select: { balance: true, carriedFrom: true },
    })
    if (tbRow && typeof tbRow.balance === 'number') {
      liveTb = { balance: tbRow.balance, carriedFrom: tbRow.carriedFrom ?? 0 }
    } else {
      const cfg = payRules[0]?.configJson ? (JSON.parse(payRules[0].configJson) as any) : {}
      const timeBankConfig = { negative_carry: 'reset', ...(cfg?.modifiers?.time_bank ?? {}) }
      const computed = await calculateTimeBank(params.empId, periodStart, timeBankConfig, prisma)
      await persistTimeBank(prisma, params.empId, periodStart, computed)
      liveTb = { balance: computed.balance, carriedFrom: computed.carriedFrom }
    }
  } catch (e) {
    // 重算失敗唔阻擋頁面 —— liveTb=null → D3 對數行退化做 detailJson 口徑
    console.error('[payroll-emp-detail] live TimeBank 解析失敗，對數行退化 detailJson 口徑', e)
  }

  // ★ PunchCorrection has clinicId but no Clinic relation — fetch clinic names separately
  const clinicIds = [...new Set(corrections.map((c: any) => c.clinicId).filter(Boolean))]
  const clinicsMap = new Map<string, { name: string; shortName: string | null }>()
  if (clinicIds.length > 0) {
    const clinics = await prisma.clinic.findMany({
      where: { id: { in: clinicIds } },
      select: { id: true, name: true, shortName: true },
    })
    for (const c of clinics) clinicsMap.set(c.id, { name: c.name, shortName: c.shortName })
  }

  return NextResponse.json({
    item: { ...item, manualEntries },
    detail, punches, leaves, corrections,
    clinicsMap: Object.fromEntries(clinicsMap),
    periodMonth: periodMonthKey(item.run.periodMonth),
    // ★ 編更差額
    rosterSpanMinutes,
    expectedMinutes,
    rosterDiffMinutes: rosterSpanMinutes - expectedMinutes,
    // ★ cwm-tbcache-rosterdiff-20260909 D3：live 時間帳戶（對數行用）
    timeBank: liveTb,
  }, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  })
}
