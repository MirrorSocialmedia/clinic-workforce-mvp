export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hkDateStart, hkDateEnd, toHKDateStr } from '@/lib/hk-date'
import { buildShiftFromInput, buildShiftTimes, hkTimeOf } from '@/lib/shift-write'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, requirePerm, isAuthError, assertClinicAccess } from '@/lib/require-auth'
import { checkShiftLeaveConflict } from '@/lib/shift-validator'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

// ============================================================
// GET /api/shifts — list shifts with filters
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  // GET: try permission-based scope first; fall back to general auth (self scope)
  const authPerm = await requirePerm(req, 'scheduling')
  const auth = isAuthError(authPerm)
    ? await requireAuth(req, 'GET', req.url) // no scheduling perm → general self scope
    : authPerm // has scheduling perm → my-clinics scope
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const employeeId = searchParams.get('employeeId')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')
  const status = searchParams.get('status')
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  const pageSize = Math.min(2000, Math.max(1, parseInt(searchParams.get('pageSize') || '50', 10) || 50))
  const skip = (page - 1) * pageSize

  const where: any = {}

  if (clinicId) where.clinicId = clinicId
  if (employeeId) where.employeeId = employeeId
  if (status) where.status = status

  if (startDate || endDate) {
    where.date = {}
    // Parse date-only strings as Hong Kong time via hkDateStart/hkDateEnd
    if (startDate) where.date.gte = hkDateStart(startDate)
    if (endDate) where.date.lte = hkDateEnd(endDate)
  }

  // Scope filtering
  if (scope === 'self') {
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    // ★ fail-closed：冇 Employee 記錄唔可以當「冇限制」
    if (!emp) {
      return NextResponse.json(
        { error: 'Employee profile not found' },
        { status: 400, headers: { 'Cache-Control': 'no-store, must-revalidate' } },
      )
    }
    where.employeeId = emp.id
  } else if (scope === 'my-clinics' && (session.clinics ?? []).length > 0) {
    where.clinicId = { in: session.clinics ?? [] }
  }

  const [shifts, total] = await Promise.all([
    prisma.shift.findMany({
      where,
      include: {
        employee: {
          include: {
            user: { select: { id: true, name: true, phone: true } },
          },
        },
        clinic: { select: { id: true, name: true } },
        template: { select: { id: true, name: true } },
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      skip,
      take: pageSize,
    }),
    prisma.shift.count({ where }),
  ])

  // Batch-check punch records (fix N+1: 1 query instead of N+1)
  let shiftsWithPunch = shifts
  if (shifts.length > 0) {
    const batchStart = startDate ? hkDateStart(startDate) : new Date(0)
    const batchEnd = endDate ? hkDateEnd(endDate) : new Date(8640000000000000)

    const allPunches = await prisma.punchRecord.findMany({
      where: {
        employeeId: { in: shifts.map((s: any) => s.employeeId) },
        punchType: 'CLOCK_IN',
        punchTime: { gte: batchStart, lte: batchEnd },
        void: { is: null }, // Exclude voided punches
      },
    })

    shiftsWithPunch = shifts.map((s: any) => {
      const dayStart = hkDateStart(s.date)
      const dayEnd = hkDateEnd(s.date)
      const hasPunch = allPunches.some((p: any) =>
        p.employeeId === s.employeeId &&
        p.clinicId === s.clinicId &&
        p.punchTime >= dayStart &&
        p.punchTime <= dayEnd
      )
      return { ...s, hasPunch }
    })
  }

  return NextResponse.json(
    { shifts: shiftsWithPunch, total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  )
}

// ============================================================
// POST /api/shifts — create shift
// Roles: OWNER, MANAGER
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()
      const {
        employeeId,
        clinicId,
        date,
        startTime,
        endTime,
        role,
        templateId,
        status = 'CONFIRMED',
        bulkDates,
        secondaryClinicId,
      } = body

      if (!employeeId || !clinicId || !date || !startTime || !endTime) {
        return NextResponse.json(
          { error: 'employeeId, clinicId, date, startTime, and endTime are required' },
          { status: 400 }
        )
      }

      // Validate clinic access + employee belongs to clinic (OWNER can bypass)
      if (scope !== 'all') {
        // ★ 同 PUT 一致：經理只可以喺自己管嘅店排更
        const denied = assertClinicAccess(scope, session, clinicId)
        if (denied) return denied

        // ★ secondaryClinicId 也要檢查權限
        if (secondaryClinicId) {
          const deniedSecondary = assertClinicAccess(scope, session, secondaryClinicId)
          if (deniedSecondary) return deniedSecondary
          // ★ 調鋪店不可與主店相同
          if (secondaryClinicId === clinicId) {
            return NextResponse.json({ error: '調鋪店不可與主店相同' }, { status: 400 })
          }
        }

        const empClinic = await prisma.employeeClinic.findFirst({
          where: { employeeId, clinicId },
        })
        if (!empClinic) {
          return NextResponse.json(
            { error: 'Employee is not assigned to this clinic' },
            { status: 400 }
          )
        }
      }

      const shifts: any[] = []

      /**
       * Check for overlapping shifts (Fix #4: shift overlap validation)
       */
      async function checkShiftOverlap(empId: string, _dateVal: Date, startVal: Date, endVal: Date) {
        return prisma.shift.findFirst({
          where: {
            employeeId: empId,
            status: { not: 'CANCELLED' },
            date: { gte: new Date(startVal.getTime() - 86400000), lte: endVal },
            startTime: { lt: endVal },
            endTime: { gt: startVal },
          },
          select: { id: true, clinicId: true, startTime: true, endTime: true },
        })
      }

      if (bulkDates && Array.isArray(bulkDates) && bulkDates.length > 0) {
        const { startTime: origStart, endTime: origEnd } = buildShiftFromInput(date, startTime, endTime)

        const planned: Array<{ d: string; times: ReturnType<typeof buildShiftTimes> }> = []
        for (const d of bulkDates) {
          const times = buildShiftTimes(d, hkTimeOf(origStart), hkTimeOf(origEnd))

          const overlap = await checkShiftOverlap(employeeId, times.date, times.startTime, times.endTime)
          if (overlap) {
            return NextResponse.json(
              { error: `${d} 該員工在此時段已有排班`, conflictShiftId: overlap.id, date: d },
              { status: 409 }
            )
          }

          const leaveConflict = await checkShiftLeaveConflict(employeeId, times.date)
          if (leaveConflict.conflict) {
            return NextResponse.json(
              { error: `${d} 該員工已有假期（${leaveConflict.leaveName}），無法排班`, date: d },
              { status: 409 }
            )
          }

          planned.push({ d, times })
        }

        const created = await prisma.$transaction(
          planned.map(p => prisma.shift.create({
            data: {
              employeeId,
              clinicId,
              date: p.times.date,
              startTime: p.times.startTime,
              endTime: p.times.endTime,
              role: role || null,
              status: status as any,
              templateId: templateId || null,
              secondaryClinicId: secondaryClinicId || null,
              createdBy: session.userId,
            },
            include: {
              employee: { include: { user: { select: { id: true, name: true } } } },
              clinic: { select: { id: true, name: true } },
              template: { select: { id: true, name: true } },
            },
          }))
        )
        shifts.push(...created)
      } else {
        // Parse date as HK midnight to avoid UTC midnight issue
        const times = buildShiftFromInput(date, startTime, endTime)

        // Fix #4: check overlap before creating
        const overlap = await checkShiftOverlap(employeeId, times.date, times.startTime, times.endTime)
        if (overlap) {
          return NextResponse.json(
            { error: '該員工在此時段已有排班', conflictShiftId: overlap.id },
            { status: 409 }
          )
        }

        // Fix: check leave conflict before creating
        const leaveConflict = await checkShiftLeaveConflict(employeeId, times.date)
        if (leaveConflict.conflict) {
          return NextResponse.json(
            { error: `該員工該天已有假期（${leaveConflict.leaveName}），無法排班` },
            { status: 409 }
          )
        }

        const shift = await prisma.shift.create({
          data: {
            employeeId,
            clinicId,
            date: times.date,
            startTime: times.startTime,
            endTime: times.endTime,
            role: role || null,
            status: status as any,
            templateId: templateId || null,
            secondaryClinicId: secondaryClinicId || null,
            createdBy: session.userId,
          },
          include: {
            employee: { include: { user: { select: { id: true, name: true } } } },
            clinic: { select: { id: true, name: true } },
            template: { select: { id: true, name: true } },
          },
        })

        shifts.push(shift)
      }

      // ★ 排班影響遲到／早退／OT 判斷 → 快取要失效
      // 批量排班用最早日期（invalidateTimeBankFrom 會清該月及之後全部）
      if (shifts.length > 0) {
        const dates = shifts.map((s: any) => new Date(s.date).getTime()).sort()
        const earliest = new Date(dates[0])
        const empId = shifts[0].employeeId
        await invalidateTimeBankFrom(empId, earliest, prisma)
      }

      return NextResponse.json(
        { success: true, shifts, count: shifts.length },
        { status: 201 }
      )
    } catch (error: any) {
      // ★ P2002: unique constraint violation (duplicate shift submission)
      if (error?.code === 'P2002') {
        return NextResponse.json(
          { error: '該時段已有相同排班（可能重複提交）' },
          { status: 409 }
        )
      }
      console.error('Create shift error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
