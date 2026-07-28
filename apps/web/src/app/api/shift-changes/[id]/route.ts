export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError, assertClinicAccess } from '@/lib/require-auth'
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

    // ★ MANAGER 只可以審自己店嘅換更
    const denied = assertClinicAccess(scope, session, changeRequest.shift?.clinicId)
    if (denied) return denied

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
      // ★ 換更 / 頂更都會改 Shift.employeeId，同樣要防撞更。
      //   D1 個守喺 PUT /api/shifts/[id]，呢條路徑直接 prisma.shift.update 會繞過。
      if (changeRequest.toEmployeeId) {
        const s = changeRequest.shift   // include 已經帶咗
        const clash = await prisma.shift.findFirst({
          where: {
            id: { not: changeRequest.shiftId },
            employeeId: changeRequest.toEmployeeId,
            status: { not: 'CANCELLED' },
            date: { gte: new Date(s.startTime.getTime() - 86400000), lte: s.endTime },
            startTime: { lt: s.endTime },
            endTime: { gt: s.startTime },
          },
          select: { id: true, clinicId: true, startTime: true, endTime: true },
        })
        if (clash) {
          return NextResponse.json(
            { error: '接更員工在此時段已有排班，無法批准', conflictShiftId: clash.id },
            { status: 409 },
          )
        }
      }

      if (changeRequest.type === 'SWAP' && changeRequest.toEmployeeId) {
        // ★ 同店分更：對手員工當日可能有多張更，要揀【時段最貼近】嗰張，
        //   唔可以靠 findFirst（順序由 DB 決定，換錯更而且唔可重現）。
        const s = changeRequest.shift
        const candidates = await prisma.shift.findMany({
          where: {
            employeeId: changeRequest.toEmployeeId,
            clinicId: s.clinicId,
            status: { not: 'CANCELLED' },
            // 唔用 date 相等：通宵更嘅 date 係開工日
            date: { gte: new Date(s.startTime.getTime() - 86400000), lte: s.endTime },
          },
          orderBy: [{ startTime: 'asc' }],
        })
        const targetShift = candidates.sort((a, b) =>
          Math.abs(a.startTime.getTime() - s.startTime.getTime()) -
          Math.abs(b.startTime.getTime() - s.startTime.getTime())
        )[0] ?? null

        if (targetShift) {
          try {
            await prisma.$transaction([
              prisma.shift.update({ where: { id: changeRequest.shiftId }, data: { employeeId: changeRequest.toEmployeeId! } }),
              prisma.shift.update({ where: { id: targetShift.id }, data: { employeeId: changeRequest.fromEmployeeId } }),
            ])
          } catch (e: any) {
            if (e?.code === 'P2002') {
              return NextResponse.json(
                { error: '換更衝突：該時段已有相同排班' },
                { status: 409 },
              )
            }
            throw e
          }
        } else {
          try {
            await prisma.shift.update({ where: { id: changeRequest.shiftId }, data: { employeeId: changeRequest.toEmployeeId! } })
          } catch (e: any) {
            if (e?.code === 'P2002') {
              return NextResponse.json(
                { error: '換更衝突：該時段已有相同排班' },
                { status: 409 },
              )
            }
            throw e
          }
        }
      } else if (changeRequest.type === 'COVER' && changeRequest.toEmployeeId) {
        try {
          await prisma.shift.update({ where: { id: changeRequest.shiftId }, data: { employeeId: changeRequest.toEmployeeId! } })
        } catch (e: any) {
          if (e?.code === 'P2002') {
            return NextResponse.json(
              { error: '頂更衝突：該時段已有相同排班' },
              { status: 409 },
            )
          }
          throw e
        }
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
  const { session, scope } = auth

  try {
    const id = params.id
    const changeRequest = await prisma.shiftChangeRequest.findUnique({
      where: { id },
      include: { shift: { select: { clinicId: true } } },
    })
    if (!changeRequest) return NextResponse.json({ error: 'Change request not found' }, { status: 404 })

    // ★ MANAGER 只可以管理自己店嘅換更
    const denied = assertClinicAccess(scope, session, changeRequest.shift?.clinicId)
    if (denied) return denied

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
