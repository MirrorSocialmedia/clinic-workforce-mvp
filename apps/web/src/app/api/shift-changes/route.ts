export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// POST /api/shift-changes — create shift change request
// Roles: OWNER, MANAGER, EMPLOYEE
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
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
      const { shiftId, toEmployeeId, type, reason } = body

      if (!shiftId || !type || !['SWAP', 'COVER', 'REPORT'].includes(type)) {
        return NextResponse.json(
          { error: 'shiftId and valid type (SWAP/COVER/REPORT) are required' },
          { status: 400 }
        )
      }

      const fromEmp = await prisma.employee.findUnique({
        where: { userId: session.userId },
      })

      if (!fromEmp) {
        return NextResponse.json({ error: 'No employee record found' }, { status: 404 })
      }

      const shift = await prisma.shift.findUnique({ where: { id: shiftId } })
      if (!shift) {
        return NextResponse.json({ error: 'Shift not found' }, { status: 404 })
      }

      // EMPLOYEE can only request changes for their own shifts
      if (scope === 'self' && shift.employeeId !== fromEmp.id) {
        return NextResponse.json({ error: 'This shift does not belong to you' }, { status: 403 })
      }

      if ((type === 'SWAP' || type === 'COVER') && !toEmployeeId) {
        return NextResponse.json(
          { error: 'toEmployeeId is required for SWAP and COVER types' },
          { status: 400 }
        )
      }

      const changeRequest = await prisma.$transaction(async (tx) => {
        const req = await tx.shiftChangeRequest.create({
          data: {
            shiftId,
            fromEmployeeId: fromEmp.id,
            toEmployeeId: toEmployeeId || null,
            type: type as any,
            reason: reason || null,
            status: 'PENDING',
          },
          include: {
            shift: { include: { clinic: { select: { id: true, name: true } } } },
            fromEmployee: { include: { user: { select: { id: true, name: true } } } },
            toEmployee: { include: { user: { select: { id: true, name: true } } } },
          },
        })

        return req
      })

      return NextResponse.json({ success: true, changeRequest }, { status: 201 })
    } catch (error) {
      console.error('Create shift change request error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}

// ============================================================
// GET /api/shift-changes — list change requests
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const type = searchParams.get('type')

  const where: any = {}

  if (scope === 'self') {
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    if (emp) {
      where.OR = [
        { fromEmployeeId: emp.id },
        { toEmployeeId: emp.id },
      ]
    }
  } else if (scope === 'my-clinics' && session.clinics.length > 0) {
    where.OR = session.clinics.map((clinicId: string) => ({
      shift: { clinicId },
    }))
  }

  if (status) where.status = status
  if (type) where.type = type

  const requests = await prisma.shiftChangeRequest.findMany({
    where,
    include: {
      shift: {
        include: {
          clinic: { select: { id: true, name: true } },
          employee: { include: { user: { select: { id: true, name: true } } } },
        },
      },
      fromEmployee: { include: { user: { select: { id: true, name: true } } } },
      toEmployee: { include: { user: { select: { id: true, name: true } } } },
      approver: { include: { user: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({ requests, total: requests.length })
}
