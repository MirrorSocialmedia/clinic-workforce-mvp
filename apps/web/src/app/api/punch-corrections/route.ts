import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// POST /api/punch-corrections — Create a punch correction request
// Roles: OWNER, MANAGER, EMPLOYEE
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

      // Check if there's already an existing punch record for this date+type at this clinic
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

      // Transaction: create correction (audit handled by Prisma extension)
      const correction = await prisma.$transaction(async (tx) => {
        const c = await tx.punchCorrection.create({
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

        return c
      })

      return NextResponse.json(
        { success: true, correction },
        { status: 201 }
      )
    } catch (error) {
      console.error('Punch correction error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}

// ============================================================
// GET /api/punch-corrections — List punch corrections
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const employeeId = searchParams.get('employeeId')
  const status = searchParams.get('status')

  const where: any = {}

  // EMPLOYEE only sees their own corrections
  if (scope === 'self') {
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    if (emp) {
      where.employeeId = emp.id
    }
  }

  if (clinicId) where.clinicId = clinicId
  if (employeeId && scope !== 'self') where.employeeId = employeeId
  if (status) where.status = status

  // MANAGER only sees their clinics
  if (scope === 'my-clinics' && session.clinics.length > 0) {
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
