export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/shifts — list shifts with filters
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const employeeId = searchParams.get('employeeId')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')
  const status = searchParams.get('status')
  const page = parseInt(searchParams.get('page') || '1')
  const pageSize = parseInt(searchParams.get('pageSize') || '50')
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
    if (emp) {
      where.employeeId = emp.id
    }
  } else if (scope === 'my-clinics' && session.clinics.length > 0) {
    where.clinicId = { in: session.clinics }
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
      },
    })

    shiftsWithPunch = shifts.map((s: any) => {
      const dayStart = new Date(s.date); dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(s.date); dayEnd.setHours(23, 59, 59, 999)
      const hasPunch = allPunches.some((p: any) =>
        p.employeeId === s.employeeId &&
        p.clinicId === s.clinicId &&
        p.punchTime >= dayStart &&
        p.punchTime <= dayEnd
      )
      return { ...s, hasPunch }
    })
  }

  return NextResponse.json({
    shifts: shiftsWithPunch,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  })
}

// ============================================================
// POST /api/shifts — create shift
// Roles: OWNER, MANAGER
// ============================================================
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
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
      } = body

      if (!employeeId || !clinicId || !date || !startTime || !endTime) {
        return NextResponse.json(
          { error: 'employeeId, clinicId, date, startTime, and endTime are required' },
          { status: 400 }
        )
      }

      // Validate employee belongs to clinic (OWNER can bypass)
      if (scope !== 'all') {
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
      async function checkShiftOverlap(empId: string, dateVal: Date, startVal: Date, endVal: Date) {
        return prisma.shift.findFirst({
          where: {
            employeeId: empId,
            date: dateVal,
            status: { not: 'CANCELLED' },
            OR: [
              { startTime: { lt: endVal }, endTime: { gt: startVal } },
            ],
          },
        })
      }

      if (bulkDates && Array.isArray(bulkDates) && bulkDates.length > 0) {
        const start = new Date(startTime)
        const end = new Date(endTime)
        for (const d of bulkDates) {
          // date column: midnight HK for correct calendar display
          const bulkDate = hkDateStart(d)
          // startTime/endTime: use frontend ISO directly (correct UTC)

          // Fix #4: check overlap before creating (use bulkDate for date column match)
          const overlap = await checkShiftOverlap(employeeId, bulkDate, start, end)
          if (overlap) {
            return NextResponse.json(
              { error: '該員工在此時段已有排班', conflictShiftId: overlap.id, date: d },
              { status: 409 }
            )
          }

          const shift = await prisma.shift.create({
            data: {
              employeeId,
              clinicId,
              date: bulkDate,
              startTime: start,
              endTime: end,
              role: role || null,
              status: status as any,
              templateId: templateId || null,
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
      } else {
        const start = new Date(startTime)
        const end = new Date(endTime)
        // Parse date as HK midnight to avoid UTC midnight issue
        const hkDate = hkDateStart(date)
        // Use frontend ISO strings directly — they already have correct UTC time
        // No need for toTimeString() which depends on server timezone

        // Fix #4: check overlap before creating (use hkDate for date field match)
        const overlap = await checkShiftOverlap(employeeId, hkDate, start, end)
        if (overlap) {
          return NextResponse.json(
            { error: '該員工在此時段已有排班', conflictShiftId: overlap.id },
            { status: 409 }
          )
        }

        const shift = await prisma.shift.create({
          data: {
            employeeId,
            clinicId,
            date: hkDate,
            startTime: start,
            endTime: end,
            role: role || null,
            status: status as any,
            templateId: templateId || null,
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

      return NextResponse.json(
        { success: true, shifts, count: shifts.length },
        { status: 201 }
      )
    } catch (error) {
      console.error('Create shift error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
