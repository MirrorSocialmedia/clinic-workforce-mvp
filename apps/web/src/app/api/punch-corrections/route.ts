export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma, createAuditLog } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// ============================================================
// POST /api/punch-corrections — Create a punch correction request
// Roles: OWNER, MANAGER, EMPLOYEE
// ============================================================
export async function POST(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  try {
    const body = await req.json()
    const { date, punchType, reason, clinicId } = body

    // Validate
    if (!date || !punchType || !clinicId) {
      return NextResponse.json(
        { error: 'date, punchType, and clinicId are required' },
        { status: 400 }
      )
    }

    if (!['CLOCK_IN', 'CLOCK_OUT'].includes(punchType)) {
      return NextResponse.json(
        { error: 'punchType must be CLOCK_IN or CLOCK_OUT' },
        { status: 400 }
      )
    }

    // Get employee
    const employee = await prisma.employee.findUnique({
      where: { userId: session.userId },
      include: {
        clinics: { select: { clinicId: true } },
      },
    })

    if (!employee) {
      return NextResponse.json(
        { error: 'Employee profile not found' },
        { status: 400 }
      )
    }

    // Verify employee belongs to clinic
    const empClinicIds = employee.clinics.map((ec: any) => ec.clinicId)
    if (!empClinicIds.includes(clinicId)) {
      return NextResponse.json(
        { error: 'You are not assigned to this clinic' },
        { status: 403 }
      )
    }

    // Check if there's already an existing punch record for this date+type
    const correctedDate = new Date(date)
    correctedDate.setHours(0, 0, 0, 0)
    const endOfDay = new Date(date)
    endOfDay.setHours(23, 59, 59, 999)

    let punchRecordId: string | null = null
    const existing = await prisma.punchRecord.findFirst({
      where: {
        employeeId: employee.id,
        clinicId,
        punchType: punchType as any,
        punchTime: { gte: correctedDate, lte: endOfDay },
      },
    })

    if (existing) {
      punchRecordId = existing.id
    }

    // Create correction request
    const correction = await prisma.punchCorrection.create({
      data: {
        punchRecordId,
        employeeId: employee.id,
        clinicId,
        correctedTime: new Date(date),
        punchType: punchType as any,
        reason: reason || null,
        requestedBy: session.userId,
        status: session.role === 'OWNER' || session.role === 'MANAGER' ? 'APPROVED' : 'PENDING',
        approvedBy: session.role === 'OWNER' || session.role === 'MANAGER' ? session.userId : null,
      },
    })

    // Audit log
    await createAuditLog({
      action: correction.status === 'APPROVED' ? 'APPROVE' : 'REQUEST',
      entity: 'PunchCorrection',
      entityId: correction.id,
      notes: `Punch correction ${correction.status} for ${punchType} on ${date}`,
    })

    return NextResponse.json(
      { success: true, correction },
      { status: 201 }
    )
  } catch (error) {
    console.error('Punch correction error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============================================================
// GET /api/punch-corrections — List punch corrections
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
  const status = searchParams.get('status')

  const where: any = {}

  // Employees only see their own corrections
  if (session.role === 'EMPLOYEE') {
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    if (emp) {
      where.employeeId = emp.id
    }
  }

  if (clinicId) where.clinicId = clinicId
  if (employeeId && session.role !== 'EMPLOYEE') where.employeeId = employeeId
  if (status) where.status = status

  // MANAGER only sees their clinics
  if (session.role === 'MANAGER' && session.clinics.length > 0) {
    where.clinicId = { in: session.clinics }
  }

  const corrections = await prisma.punchCorrection.findMany({
    where,
    include: {
      punchRecord: {
        include: {
          employee: {
            include: {
              user: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return NextResponse.json({ corrections })
}
