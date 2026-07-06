export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma, createAuditLog } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'
import { createNotification } from '@/lib/notification'

// ============================================================
// PUT /api/leave-requests/[id] — Approve/Reject leave request
// Roles: OWNER, MANAGER
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!['OWNER', 'MANAGER'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  try {
    const body = await req.json()
    const { action, notes } = body
    const requestId = params.id

    if (!['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json(
        { error: 'action must be APPROVE or REJECT' },
        { status: 400 }
      )
    }

    const request = await prisma.leaveRequest.findUnique({
      where: { id: requestId },
      include: {
        leaveType: { select: { id: true, name: true, isPaid: true } },
        employee: {
          include: {
            user: { select: { id: true, name: true } },
          },
        },
      },
    })

    if (!request) return NextResponse.json({ error: 'Leave request not found' }, { status: 404 })
    if (request.status !== 'PENDING') {
      return NextResponse.json(
        { error: `Request already ${request.status}` },
        { status: 400 }
      )
    }

    const status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED'

    const updated = await prisma.leaveRequest.update({
      where: { id: requestId },
      data: {
        status: status as any,
        approverId: session.userId,
        approvedAt: new Date(),
      },
    })

    // If approved, deduct from balance
    if (status === 'APPROVED') {
      const currentYear = new Date().getFullYear()
      await prisma.leaveBalance.upsert({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year: currentYear,
          },
        },
        create: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          year: currentYear,
          entitled: 0,
          used: request.days,
          remaining: -request.days,
        },
        update: {
          used: { increment: request.days },
          remaining: { decrement: request.days },
        },
      })
    }

    // Send notification to employee
    await createNotification({
      employeeId: request.employeeId,
      type: status === 'APPROVED' ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED',
      content: status === 'APPROVED'
        ? `Your ${request.leaveType.name} request (${request.days} days) has been approved.`
        : `Your ${request.leaveType.name} request (${request.days} days) has been rejected.${notes ? ` Reason: ${notes}` : ''}`,
      relatedEntity: 'LeaveRequest',
      relatedId: request.id,
    })

    await createAuditLog({
      action: 'LEAVE_' + action,
      entity: 'LeaveRequest',
      entityId: request.id,
      notes: `${action} leave request #${requestId} for ${request.employee.user.name}: ${request.leaveType.name} ${request.days} days${notes ? ` — ${notes}` : ''}`,
    })

    return NextResponse.json({ success: true, leaveRequest: updated })
  } catch (error) {
    console.error('Leave request approval error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
