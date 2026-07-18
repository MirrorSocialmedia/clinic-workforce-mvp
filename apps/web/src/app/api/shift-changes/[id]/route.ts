export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { createNotification } from '@/lib/notification'

// PUT /api/shift-changes/[id] — approve/reject shift change
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const id = params.id
    const body = await req.json()
    const { action, reason } = body

    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json({ error: 'action (APPROVE or REJECT) is required' }, { status: 400 })
    }

    const changeRequest = await prisma.shiftChangeRequest.findUnique({
      where: { id },
      include: { shift: true, fromEmployee: true, toEmployee: true },
    })

    if (!changeRequest) return NextResponse.json({ error: 'Change request not found' }, { status: 404 })
    if (changeRequest.status !== 'PENDING') {
      return NextResponse.json({ error: `Change request is already ${changeRequest.status}` }, { status: 409 })
    }

    const beforeJson = JSON.stringify(changeRequest)

    const approverEmp = await prisma.employee.findUnique({ where: { userId: session.userId } })
    if (!approverEmp) return NextResponse.json({ error: 'No employee record found for approver' }, { status: 404 })

    if (action === 'REJECT') {
      const updated = await prisma.shiftChangeRequest.update({
        where: { id },
        data: { status: 'REJECTED', approverId: approverEmp.id, approvedAt: new Date() },
        include: {
          shift: { include: { clinic: { select: { id: true, name: true } }, employee: { include: { user: { select: { id: true, name: true } } } } } },
          fromEmployee: { include: { user: { select: { id: true, name: true } } } },
          toEmployee: { include: { user: { select: { id: true, name: true } } } },
          approver: { include: { user: { select: { id: true, name: true } } } },
        },
      })

      // Audit handled by Prisma extension (ShiftChangeRequest ∈ AUDIT_ENTITIES)

      await createNotification({
        employeeId: changeRequest.fromEmployeeId, type: 'SHIFT_CHANGED',
        content: `Your shift change request (${changeRequest.type}) has been rejected.${reason ? ` Reason: ${reason}` : ''}`,
        relatedEntity: 'ShiftChangeRequest', relatedId: id,
      })

      return NextResponse.json({ success: true, changeRequest: updated })
    }

    // APPROVE action
    if (action === 'APPROVE') {
      if (changeRequest.type === 'SWAP' && changeRequest.toEmployeeId) {
        const targetShift = await prisma.shift.findFirst({
          where: {
            employeeId: changeRequest.toEmployeeId,
            clinicId: changeRequest.shift.clinicId,
            date: changeRequest.shift.date,
            status: { not: 'CANCELLED' },
          },
        })

        if (targetShift) {
          await prisma.$transaction([
            prisma.shift.update({ where: { id: changeRequest.shiftId }, data: { employeeId: changeRequest.toEmployeeId! } }),
            prisma.shift.update({ where: { id: targetShift.id }, data: { employeeId: changeRequest.fromEmployeeId } }),
          ])
        } else {
          await prisma.shift.update({ where: { id: changeRequest.shiftId }, data: { employeeId: changeRequest.toEmployeeId! } })
        }
      } else if (changeRequest.type === 'COVER' && changeRequest.toEmployeeId) {
        await prisma.shift.update({ where: { id: changeRequest.shiftId }, data: { employeeId: changeRequest.toEmployeeId! } })
      }

      const updated = await prisma.shiftChangeRequest.update({
        where: { id },
        data: {
          status: changeRequest.type === 'REPORT' ? 'COMPLETED' : 'APPROVED',
          approverId: approverEmp.id, approvedAt: new Date(),
        },
        include: {
          shift: { include: { clinic: { select: { id: true, name: true } }, employee: { include: { user: { select: { id: true, name: true } } } } } },
          fromEmployee: { include: { user: { select: { id: true, name: true } } } },
          toEmployee: { include: { user: { select: { id: true, name: true } } } },
          approver: { include: { user: { select: { id: true, name: true } } } },
        },
      })

      // Audit handled by Prisma extension (ShiftChangeRequest ∈ AUDIT_ENTITIES)

      await createNotification({
        employeeId: changeRequest.fromEmployeeId, type: 'SHIFT_CHANGED',
        content: `Your shift change request (${changeRequest.type}) has been approved.`,
        relatedEntity: 'ShiftChangeRequest', relatedId: id,
      })

      return NextResponse.json({ success: true, changeRequest: updated })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  })
}

// DELETE /api/shift-changes/[id] — cancel pending request
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  try {
    const id = params.id
    const changeRequest = await prisma.shiftChangeRequest.findUnique({ where: { id } })
    if (!changeRequest) return NextResponse.json({ error: 'Change request not found' }, { status: 404 })

    const emp = await prisma.employee.findUnique({ where: { userId: session.userId } })
    if (!emp || emp.id !== changeRequest.fromEmployeeId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (changeRequest.status !== 'PENDING') {
      return NextResponse.json({ error: 'Can only cancel pending requests' }, { status: 409 })
    }

    await prisma.shiftChangeRequest.update({ where: { id }, data: { status: 'REJECTED' } })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Cancel shift change error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
