import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'
import { createNotification } from '@/lib/notification'

// ============================================================
// PUT /api/shift-changes/[id] — approve/reject shift change
// Roles: OWNER, MANAGER
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  try {
    const id = params.id
    const body = await req.json()
    const { action, reason } = body // action: 'APPROVE' | 'REJECT'

    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json(
        { error: 'action (APPROVE or REJECT) is required' },
        { status: 400 }
      )
    }

    // Get the change request
    const changeRequest = await prisma.shiftChangeRequest.findUnique({
      where: { id },
      include: {
        shift: true,
        fromEmployee: true,
        toEmployee: true,
      },
    })

    if (!changeRequest) {
      return NextResponse.json({ error: 'Change request not found' }, { status: 404 })
    }

    if (changeRequest.status !== 'PENDING') {
      return NextResponse.json(
        { error: `Change request is already ${changeRequest.status}` },
        { status: 409 }
      )
    }

    const beforeJson = JSON.stringify(changeRequest)

    // Get approver's employee record
    const approverEmp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })

    if (!approverEmp) {
      return NextResponse.json(
        { error: 'No employee record found for approver' },
        { status: 404 }
      )
    }

    if (action === 'REJECT') {
      // Reject the request
      const updated = await prisma.shiftChangeRequest.update({
        where: { id },
        data: {
          status: 'REJECTED',
          approverId: approverEmp.id,
          approvedAt: new Date(),
        },
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
      })

      // Audit log
      await prisma.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'REJECT',
          entity: 'ShiftChangeRequest',
          entityId: id,
          clinicId: changeRequest.shift.clinicId,
          notes: reason || 'Change request rejected',
          beforeJson,
          afterJson: JSON.stringify(updated),
        },
      })

      // Send notification to requesting employee
      await createNotification({
        employeeId: changeRequest.fromEmployeeId,
        type: 'SHIFT_CHANGED',
        content: `Your shift change request (${changeRequest.type}) has been rejected.${reason ? ` Reason: ${reason}` : ''}`,
        relatedEntity: 'ShiftChangeRequest',
        relatedId: id,
      })

      return NextResponse.json({ success: true, changeRequest: updated })
    }

    // APPROVE action
    if (action === 'APPROVE') {
      // Execute the change based on type
      if (changeRequest.type === 'SWAP' && changeRequest.toEmployeeId) {
        // SWAP: swap employees between shifts
        // Find the target employee's shift on the same date at the same clinic
        const targetShift = await prisma.shift.findFirst({
          where: {
            employeeId: changeRequest.toEmployeeId,
            clinicId: changeRequest.shift.clinicId,
            date: changeRequest.shift.date,
            status: { not: 'CANCELLED' },
          },
        })

        if (targetShift) {
          // Swap: change employee assignments
          await prisma.$transaction([
            prisma.shift.update({
              where: { id: changeRequest.shiftId },
              data: { employeeId: changeRequest.toEmployeeId! },
            }),
            prisma.shift.update({
              where: { id: targetShift.id },
              data: { employeeId: changeRequest.fromEmployeeId },
            }),
          ])
        } else {
          // No matching shift found, just reassign
          await prisma.shift.update({
            where: { id: changeRequest.shiftId },
            data: { employeeId: changeRequest.toEmployeeId! },
          })
        }
      } else if (changeRequest.type === 'COVER' && changeRequest.toEmployeeId) {
        // COVER: reassign shift to new employee
        await prisma.shift.update({
          where: { id: changeRequest.shiftId },
          data: { employeeId: changeRequest.toEmployeeId! },
        })
      }
      // REPORT type: just mark as completed (no shift changes)

      const updated = await prisma.shiftChangeRequest.update({
        where: { id },
        data: {
          status: changeRequest.type === 'REPORT' ? 'COMPLETED' : 'APPROVED',
          approverId: approverEmp.id,
          approvedAt: new Date(),
        },
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
      })

      // Audit log
      await prisma.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'APPROVE',
          entity: 'ShiftChangeRequest',
          entityId: id,
          clinicId: changeRequest.shift.clinicId,
          notes: reason || `Change request ${changeRequest.type} approved`,
          beforeJson,
          afterJson: JSON.stringify(updated),
        },
      })

      // Send notification to requesting employee
      await createNotification({
        employeeId: changeRequest.fromEmployeeId,
        type: 'SHIFT_CHANGED',
        content: `Your shift change request (${changeRequest.type}) has been approved.`,
        relatedEntity: 'ShiftChangeRequest',
        relatedId: id,
      })

      return NextResponse.json({ success: true, changeRequest: updated })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Approve shift change error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============================================================
// DELETE /api/shift-changes/[id] — cancel pending request
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const id = params.id

    const changeRequest = await prisma.shiftChangeRequest.findUnique({
      where: { id },
    })

    if (!changeRequest) {
      return NextResponse.json({ error: 'Change request not found' }, { status: 404 })
    }

    // Only the requester can cancel
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })

    if (!emp || emp.id !== changeRequest.fromEmployeeId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (changeRequest.status !== 'PENDING') {
      return NextResponse.json(
        { error: 'Can only cancel pending requests' },
        { status: 409 }
      )
    }

    await prisma.shiftChangeRequest.update({
      where: { id },
      data: { status: 'REJECTED' }, // treat cancel as rejection
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Cancel shift change error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
