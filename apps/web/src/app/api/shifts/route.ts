import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { prisma } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// ============================================================
// GET /api/shifts — list shifts with filters
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

  if (clinicId) {
    where.clinicId = clinicId
  }

  if (employeeId) {
    where.employeeId = employeeId
  }

  if (status) {
    where.status = status
  }

  if (startDate || endDate) {
    where.date = {}
    if (startDate) where.date.gte = new Date(startDate)
    if (endDate) where.date.lte = new Date(endDate)
  }

  // Non-OWNER/MANAGER employees only see their own shifts
  if (session.role === 'EMPLOYEE') {
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    if (emp) {
      where.employeeId = emp.id
    }
  }

  // MANAGER only sees their clinics' shifts
  if (session.role === 'MANAGER' && session.clinics.length > 0) {
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
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

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
      // Bulk mode: create multiple shifts from a template
      bulkDates, // array of date strings
    } = body

    // Validate required fields
    if (!employeeId || !clinicId || !date || !startTime || !endTime) {
      return NextResponse.json(
        { error: 'employeeId, clinicId, date, startTime, and endTime are required' },
        { status: 400 }
      )
    }

    // Validate employee belongs to clinic
    const empClinic = await prisma.employeeClinic.findFirst({
      where: { employeeId, clinicId },
    })

    if (!empClinic) {
      // Allow cross-clinic scheduling for OWNER
      if (session.role !== 'OWNER') {
        return NextResponse.json(
          { error: 'Employee is not assigned to this clinic' },
          { status: 400 }
        )
      }
    }

    const shifts: any[] = []

    if (bulkDates && Array.isArray(bulkDates) && bulkDates.length > 0) {
      // Bulk create: apply same times to multiple dates
      for (const d of bulkDates) {
        const dateBase = new Date(d)
        // Calculate actual start/end times based on date
        const start = new Date(startTime)
        const end = new Date(endTime)
        // Apply the time portion to the target date
        const bulkStart = new Date(dateBase)
        bulkStart.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds())
        const bulkEnd = new Date(dateBase)
        bulkEnd.setHours(end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds())

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
            employee: {
              include: { user: { select: { id: true, name: true } } },
            },
            clinic: { select: { id: true, name: true } },
            template: { select: { id: true, name: true } },
          },
        })

        shifts.push(shift)

        // Audit log for each bulk shift
        await prisma.auditLog.create({
          data: {
            actorId: session.userId,
            action: 'CREATE',
            entity: 'Shift',
            entityId: shift.id,
            clinicId,
            afterJson: JSON.stringify({ employeeId, clinicId, date: d }),
          },
        })
      }
    } else {
      // Single shift creation
      const start = new Date(startTime)
      const end = new Date(endTime)

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
          employee: {
            include: { user: { select: { id: true, name: true } } },
          },
          clinic: { select: { id: true, name: true } },
          template: { select: { id: true, name: true } },
        },
      })

      shifts.push(shift)

      // Audit log
      await prisma.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'CREATE',
          entity: 'Shift',
          entityId: shift.id,
          clinicId,
          afterJson: JSON.stringify(shift),
        },
      })
    }

    return NextResponse.json(
      { success: true, shifts, count: shifts.length },
      { status: 201 }
    )
  } catch (error) {
    console.error('Create shift error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
