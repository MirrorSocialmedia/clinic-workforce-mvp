export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope, canSeeConfidential } from '@/lib/scope-helpers'
import { getMonthRange, periodMonthKey, toHKDateStr, hkDaysInMonth, addDaysStr } from '@/lib/hk-date'
import { rosterSpanHours } from '@/lib/shift-punch-match'

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
              company: { select: { logoData: true } },
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

  // ★ 2026-08-14: 編更差額資料（用 rosterSpanHours + 實際假期日數）
  const shifts = await prisma.shift.findMany({
    where: { employeeId: params.empId, date: { gte: periodStart, lte: periodEnd }, status: { not: 'CANCELLED' } },
    select: { employeeId: true, date: true, startTime: true, endTime: true, status: true },
  })

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
  const rosterMap = rosterSpanHours(shifts as any, leaveDateSet)
  const rosterSpanMinutes = rosterMap.get(params.empId) ?? 0

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
    item, detail, punches, leaves, corrections,
    clinicsMap: Object.fromEntries(clinicsMap),
    periodMonth: periodMonthKey(item.run.periodMonth),
    // ★ 編更差額
    rosterSpanMinutes,
    expectedMinutes,
    rosterDiffMinutes: rosterSpanMinutes - expectedMinutes,
  }, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  })
}
