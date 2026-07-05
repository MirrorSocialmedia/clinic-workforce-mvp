import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { createNotification } from '@/lib/notification'

// PUT /api/leave-requests/[id] — Approve/Reject leave request
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const body = await req.json()
    const { action, notes } = body
    const requestId = params.id

    if (!['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json({ error: 'action must be APPROVE or REJECT' }, { status: 400 })
    }

    const request = await prisma.leaveRequest.findUnique({
      where: { id: requestId },
      include: {
        leaveType: { select: { id: true, name: true, isPaid: true } },
        employee: { include: { user: { select: { id: true, name: true } } } },
      },
    })

    if (!request) return NextResponse.json({ error: 'Leave request not found' }, { status: 404 })
    if (request.status !== 'PENDING') {
      return NextResponse.json({ error: `Request already ${request.status}` }, { status: 400 })
    }

    const status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED'

    const updated = await prisma.leaveRequest.update({
      where: { id: requestId },
      data: { status: status as any, approverId: session.userId, approvedAt: new Date() },
    })

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
          employeeId: request.employeeId, leaveTypeId: request.leaveTypeId,
          year: currentYear, entitled: 0, used: request.days, remaining: -request.days,
        },
        update: { used: { increment: request.days }, remaining: { decrement: request.days } },
      })
    }

    await createNotification({
      employeeId: request.employeeId,
      type: status === 'APPROVED' ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED',
      content: status === 'APPROVED'
        ? `Your ${request.leaveType.name} request (${request.days} days) has been approved.`
        : `Your ${request.leaveType.name} request (${request.days} days) has been rejected.${notes ? ` Reason: ${notes}` : ''}`,
      relatedEntity: 'LeaveRequest',
      relatedId: request.id,
    })

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'LEAVE_' + action,
        entity: 'LeaveRequest',
        entityId: request.id,
        notes: `${action} leave request #${requestId} for ${request.employee.user.name}: ${request.leaveType.name} ${request.days} days${notes ? ` — ${notes}` : ''}`,
        ipAddress: auditCtx.ip || null,
        userAgent: auditCtx.ua || null,
      },
    })

    return NextResponse.json({ success: true, leaveRequest: updated })
  })
}
