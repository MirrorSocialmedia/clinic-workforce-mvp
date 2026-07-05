import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/shifts/my-schedule — get current employee's schedule
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(req.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    // For employees, get their own schedule
    // For managers/owners, they can optionally specify employeeId
    const employeeId = searchParams.get('employeeId') || null

    let targetEmployeeId: string | null = null

    if (employeeId) {
      // Manager/owner viewing specific employee
      targetEmployeeId = employeeId
    } else {
      // Get current user's employee record
      const emp = await prisma.employee.findUnique({
        where: { userId: session.userId },
      })
      if (emp) {
        targetEmployeeId = emp.id
      }
    }

    if (!targetEmployeeId) {
      return NextResponse.json(
        { error: 'No employee record found' },
        { status: 404 }
      )
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

    // Get pending change requests
    const pendingRequests = await prisma.shiftChangeRequest.findMany({
      where: {
        OR: [
          { fromEmployeeId: targetEmployeeId },
          { toEmployeeId: targetEmployeeId },
        ],
        status: 'PENDING',
      },
      include: {
        shift: {
          include: {
            clinic: { select: { id: true, name: true } },
          },
        },
        fromEmployee: {
          include: { user: { select: { id: true, name: true } } },
        },
        toEmployee: {
          include: { user: { select: { id: true, name: true } } },
        },
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
