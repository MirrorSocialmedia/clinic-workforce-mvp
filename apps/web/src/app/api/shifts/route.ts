export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
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
    if (startDate) where.date.gte = new Date(startDate)
    if (endDate) where.date.lte = new Date(endDate)
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

  return NextResponse.json({
    shifts,
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
        for (const d of bulkDates) {
          const dateBase = new Date(d)
          const start = new Date(startTime)
          const end = new Date(endTime)
          const bulkStart = new Date(dateBase)
          bulkStart.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds())
          const bulkEnd = new Date(dateBase)
          bulkEnd.setHours(end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds())

          // Fix #4: check overlap before creating
          const overlap = await checkShiftOverlap(employeeId, bulkStart, bulkStart, bulkEnd)
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
              date: bulkStart,
              startTime: bulkStart,
              endTime: bulkEnd,
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

        // Fix #4: check overlap before creating
        const overlap = await checkShiftOverlap(employeeId, start, start, end)
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
            date: start,
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
