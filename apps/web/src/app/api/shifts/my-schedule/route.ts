export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/shifts/my-schedule — get current employee's schedule
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  try {
    const { searchParams } = new URL(req.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const employeeId = searchParams.get('employeeId') || null

    let targetEmployeeId: string | null = null

    if (employeeId && scope !== 'self') {
      targetEmployeeId = employeeId
    } else {
      const emp = await prisma.employee.findUnique({
        where: { userId: session.userId },
      })
      if (emp) {
        targetEmployeeId = emp.id
      }
    }

    if (!targetEmployeeId) {
      return NextResponse.json({ error: 'No employee record found' }, { status: 404 })
    }

    const where: any = {
      employeeId: targetEmployeeId,
      status: { not: 'CANCELLED' },
    }

    if (startDate || endDate) {
      where.date = {}
      if (startDate) where.date.gte = new Date(startDate)
      if (endDate) where.date.lte = new Date(endDate)
    }

    const shifts = await prisma.shift.findMany({
      where,
      include: {
        clinic: { select: { id: true, name: true } },
        template: { select: { id: true, name: true } },
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    })

    const pendingRequests = await prisma.shiftChangeRequest.findMany({
      where: {
        OR: [
          { fromEmployeeId: targetEmployeeId },
          { toEmployeeId: targetEmployeeId },
        ],
        status: 'PENDING',
      },
      include: {
        shift: { include: { clinic: { select: { id: true, name: true } } } },
        fromEmployee: { include: { user: { select: { id: true, name: true } } } },
        toEmployee: { include: { user: { select: { id: true, name: true } } } },
      },
    })

    return NextResponse.json({
      shifts,
      pendingChangeRequests: pendingRequests,
      employeeId: targetEmployeeId,
    })
  } catch (error) {
    console.error('Get my schedule error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
