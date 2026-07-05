import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma, createAuditLog } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'
import { createNotification } from '@/lib/notification'

// ============================================================
// GET /api/leave-requests — List leave requests
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// EMPLOYEE sees only own; managers see all (filtered by clinic for MANAGER)
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const status = searchParams.get('status')
  const leaveTypeId = searchParams.get('leaveTypeId')

  const where: any = {}

  // Employees only see their own requests
  if (session.role === 'EMPLOYEE') {
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    if (emp) {
      where.employeeId = emp.id
    }
  }

  if (employeeId && session.role !== 'EMPLOYEE') where.employeeId = employeeId
  if (status) where.status = status
  if (leaveTypeId) where.leaveTypeId = leaveTypeId

  const requests = await prisma.leaveRequest.findMany({
    where,
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, color: true } },
      employee: {
        include: {
          user: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  return NextResponse.json({ leaveRequests: requests })
}

// ============================================================
// POST /api/leave-requests — Create leave request
// Roles: OWNER, MANAGER, EMPLOYEE
// ============================================================
export async function POST(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  try {
    const body = await req.json()
    const { leaveTypeId, startDate, endDate, days, reason } = body

    if (!leaveTypeId || !startDate || !endDate || days === undefined || days <= 0) {
      return NextResponse.json(
        { error: 'leaveTypeId, startDate, endDate, and days (positive) are required' },
        { status: 400 }
      )
    }

    // Get the requesting employee
    const employee = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })

    if (!employee) {
      return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })
    }

    const leaveType = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } })
    if (!leaveType) {
      return NextResponse.json({ error: 'Leave type not found' }, { status: 404 })
    }

    // Validate: check remaining balance if leave type has quota
    const currentYear = new Date().getFullYear()
    const balance = await prisma.leaveBalance.findFirst({
      where: {
        employeeId: employee.id,
        leaveTypeId,
        year: currentYear,
      },
    })

    if (balance && leaveType.annualQuota !== null && leaveType.annualQuota > 0) {
      if (days > balance.remaining) {
        return NextResponse.json(
          { error: `Insufficient leave balance. Remaining: ${balance.remaining} days` },
          { status: 400 }
        )
      }
    }

    // Create request
    const request = await prisma.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        days,
        reason: reason || null,
        // If OWNER or MANAGER creates, auto-approve
        status: ['OWNER', 'MANAGER'].includes(session.role) ? 'APPROVED' : 'PENDING',
        approverId: ['OWNER', 'MANAGER'].includes(session.role) ? session.userId : null,
        approvedAt: ['OWNER', 'MANAGER'].includes(session.role) ? new Date() : null,
      },
      include: {
        leaveType: { select: { id: true, name: true, isPaid: true, color: true } },
      },
    })

    // If auto-approved, deduct from balance
    if (request.status === 'APPROVED') {
      await deductLeaveBalance(employee.id, leaveTypeId, days)
      // Notify employee
      await createNotification({
        employeeId: employee.id,
        type: 'LEAVE_APPROVED',
        content: `Your ${leaveType.name} request (${days} days) has been approved.`,
        relatedEntity: 'LeaveRequest',
        relatedId: request.id,
      })
    }

    await createAuditLog({
      action: request.status === 'APPROVED' ? 'APPROVE' : 'REQUEST',
      entity: 'LeaveRequest',
      entityId: request.id,
      notes: `Leave request ${request.status}: ${leaveType.name} ${days} days`,
    })

    return NextResponse.json({ success: true, leaveRequest: request }, { status: 201 })
  } catch (error) {
    console.error('Leave request error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Helper: deduct leave balance
async function deductLeaveBalance(employeeId: string, leaveTypeId: string, days: number): Promise<void> {
  const currentYear = new Date().getFullYear()
  await prisma.leaveBalance.upsert({
    where: {
      employeeId_leaveTypeId_year: {
        employeeId,
        leaveTypeId,
        year: currentYear,
      },
    },
    create: {
      employeeId,
      leaveTypeId,
      year: currentYear,
      entitled: 0,
      used: days,
      remaining: -days,
    },
    update: {
      used: { increment: days },
      remaining: { decrement: days },
    },
  })
}
