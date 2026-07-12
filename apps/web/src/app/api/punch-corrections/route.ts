export const dynamic = 'force-dynamic'
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
      const { date, punchType, reason, clinicId, employeeId: requestBodyEmployeeId, punchRecordId: requestBodyPunchRecordId } = body

      // Validate
      if (!date || !punchType || !clinicId) {
        return NextResponse.json(
          { error: 'date, punchType, and clinicId are required' },
          { status: 400 }
        )
      }

      // Reject future punch times (Fix #2a: backend guard)
      const correctedTime = new Date(date)
      const now = new Date()
      if (correctedTime > now) {
        return NextResponse.json(
          { error: '不能補未來時間的打卡' },
          { status: 400 }
        )
      }

      if (!['CLOCK_IN', 'CLOCK_OUT'].includes(punchType)) {
        return NextResponse.json(
          { error: 'punchType must be CLOCK_IN or CLOCK_OUT' },
          { status: 400 }
        )
      }

      // Get employee — use provided employeeId (manager) or own profile (employee)
      let employee: any
      if (requestBodyEmployeeId) {
        // Manager creating for another employee
        if (session.role !== 'OWNER' && session.role !== 'MANAGER') {
          return NextResponse.json(
            { error: 'Only managers can create corrections for other employees' },
            { status: 403 }
          )
        }
        employee = await prisma.employee.findUnique({
          where: { id: requestBodyEmployeeId },
          include: { clinics: { select: { clinicId: true } } },
        })
      } else {
        employee = await prisma.employee.findUnique({
          where: { userId: session.userId },
          include: { clinics: { select: { clinicId: true } } },
        })
      }

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
          { error: 'Employee is not assigned to this clinic' },
          { status: 403 }
        )
      }

      // Check if there's already an existing punch record for this employee+clinic on this date
      // If found, link correction to it; otherwise correction will reference null
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
          void: { is: null }, // 已作廢的不算存在
        },
      })

      if (existing) {
        // Existing record found — link correction to it (correction semantics: overlay, don't create duplicate)
        punchRecordId = existing.id
      }

      // Transaction: create correction + punchRecord (if no original exists)
      const correction = await prisma.$transaction(async (tx) => {
        const isManager = session.role === 'OWNER' || session.role === 'MANAGER'
        const c = await tx.punchCorrection.create({
          data: {
            punchRecordId,
            employeeId: employee.id,
            clinicId,
            correctedTime: new Date(date),
            punchType: punchType as any,
            reason: reason || null,
            requestedBy: session.userId,
            status: isManager ? 'APPROVED' : 'PENDING',
            approvedBy: isManager ? session.userId : null,
          },
        })

        // If APPROVED and no original punchRecord exists → create one (source=CORRECTION)
        if (isManager && !punchRecordId) {
          const pr = await tx.punchRecord.create({
            data: {
              employeeId: employee.id,
              clinicId,
              punchTime: new Date(date),
              punchType: punchType as any,
              source: 'MANUAL_CORRECTION' as const,
            },
          })
          // Backfill correction's punchRecordId
          await tx.punchCorrection.update({
            where: { id: c.id },
            data: { punchRecordId: pr.id },
          })
        }

        return c
      })

      return NextResponse.json(
        { success: true, correction, createdPunchRecord: !!(!existing && (session.role === 'OWNER' || session.role === 'MANAGER')) },
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
