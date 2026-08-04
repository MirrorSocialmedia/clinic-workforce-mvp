export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { requireAuth, isAuthError, assertClinicAccess } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { createNotification } from '@/lib/notification'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { balanceYearFor } from '@/lib/leave-types'

// PUT /api/leave-requests/[id] — Approve/Reject leave request
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
    const body = await req.json()
    const { action, notes } = body
    const requestId = params.id

    if (!['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json({ error: 'action must be APPROVE or REJECT' }, { status: 400 })
    }

    const request = await prisma.leaveRequest.findUnique({
      where: { id: requestId },
      include: {
        leaveType: { select: { id: true, name: true, isPaid: true, systemKey: true } },
        employee: { include: { user: { select: { id: true, name: true } } } },
      },
    })

    if (!request) return NextResponse.json({ error: 'Leave request not found' }, { status: 404 })
    if (request.status !== 'PENDING') {
      return NextResponse.json({ error: `Request already ${request.status}` }, { status: 400 })
    }

    // ★ MANAGER 只可以審自己店員工嘅假
    const emp = await prisma.employee.findUnique({
      where: { id: request.employeeId },
      select: { homeClinicId: true },
    })
    const denied = assertClinicAccess(scope, session, emp?.homeClinicId)
    if (denied) return denied

    const status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED'

    // Fix: check shift conflict before approving
    if (action === 'APPROVE') {
      const conflictShift = await prisma.shift.findFirst({
        where: {
          employeeId: request.employeeId,
          status: { not: 'CANCELLED' },
          date: {
            gte: new Date(`${toHKDateStr(request.startDate)}T00:00:00+08:00`),
            lte: new Date(`${toHKDateStr(request.endDate || request.startDate)}T23:59:59+08:00`),
          },
        },
      })
      if (conflictShift) {
        return NextResponse.json(
          { error: `該員工在假期範圍內已有排班（${toHKDateStr(conflictShift.date)}），請先移除排班或改假期日期` },
          { status: 400 }
        )
      }
    }

    const updated = await prisma.leaveRequest.update({
      where: { id: requestId },
      data: { status: status as any, approverId: session.userId, approvedAt: new Date() },
    })

    if (status === 'APPROVED') {
      // ★ 累積制假期用 year = 0（2026-08-04 修）
      const leaveYear = balanceYearFor(request.leaveType?.systemKey, new Date(request.startDate))
      const bal = await prisma.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year: leaveYear,
          },
        },
      })
      if (!bal || bal.remaining < request.days) {
        return NextResponse.json(
          { error: `Insufficient leave balance. Remaining: ${bal?.remaining ?? 0} days` },
          { status: 400 }
        )
      }
      const updated = await prisma.leaveBalance.updateMany({
        where: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          year: leaveYear,
        },
        data: { used: { increment: request.days }, remaining: { decrement: request.days } },
      })
      if (updated.count === 0) {
        console.error(
          `[leave-approve] ⛔ 扣額度失敗：employeeId=${request.employeeId} ` +
          `leaveTypeId=${request.leaveTypeId} year=${leaveYear} days=${request.days}`,
        )
      }
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

    // ★ 假期審批影響缺勤判斷同午飯扣減 → 快取要失效
    if (status === 'APPROVED') {
      try {
        await invalidateTimeBankFrom(request.employeeId, new Date(request.startDate), prisma)
      } catch (e) {
        console.error(`[timebank-cache] invalidate failed employeeId=${request.employeeId} date=${new Date(request.startDate)}`, e)
      }
    }

    // Audit handled by Prisma extension (LeaveRequest ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true, leaveRequest: updated })
  })
}

// DELETE /api/leave-requests/[id] — Delete a leave request
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope, perms } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const requestId = params.id
      const request = await prisma.leaveRequest.findUnique({
        where: { id: requestId },
        include: { leaveType: { select: { systemKey: true } } },
      })
      if (!request) {
        return NextResponse.json({ error: 'Leave request not found' }, { status: 404 })
      }

      // ★ MANAGER 只可以刪自己店員工嘅假
      const emp = await prisma.employee.findUnique({
        where: { id: request.employeeId },
        select: { homeClinicId: true },
      })
      const denied = assertClinicAccess(scope, session, emp?.homeClinicId)
      if (denied) return denied

      // ★ 第二道閘：改用 perms（非 role 寫死），同 RBAC_PERM_OVERRIDES 一致
      if (request.status === 'APPROVED'
        && !(perms ?? []).includes('scheduling')
        && !(perms ?? []).includes('leave_approve')) {
        return NextResponse.json({ error: 'Forbidden (cannot modify approved leave)' }, { status: 403 })
      }

      // Restore leave balance if approved
      if (request.status === 'APPROVED') {
        // ★ 累積制假期用 year = 0（2026-08-04 修）
        const leaveYear = balanceYearFor(request.leaveType?.systemKey, new Date(request.startDate))
        const updated = await prisma.leaveBalance.updateMany({
          where: {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year: leaveYear,
          },
          data: { used: { decrement: request.days }, remaining: { increment: request.days } },
        })

        // ★ 唔好靜靜吞 —— 還唔到額度係資料錯誤，一定要留痕
        if (updated.count === 0) {
          console.error(
            `[leave-delete] ⛔ 還額度失敗：employeeId=${request.employeeId} ` +
            `leaveTypeId=${request.leaveTypeId} year=${leaveYear} days=${request.days}`,
          )
        }
      }

      await prisma.leaveRequest.delete({ where: { id: requestId } })

      // ★ 刪除假期影響缺勤判斷同午飯扣減 → 快取要失效
      try {
        await invalidateTimeBankFrom(request.employeeId, new Date(request.startDate), prisma)
      } catch (e) {
        console.error(`[timebank-cache] invalidate failed employeeId=${request.employeeId} date=${new Date(request.startDate)}`, e)
      }

      return NextResponse.json({ success: true })
    } catch (error) {
      console.error('Delete leave request error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}

// PATCH /api/leave-requests/[id] — Update isPlanned or approvedDays
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PATCH', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()
      const { isPlanned, approvedDays } = body

      const request = await prisma.leaveRequest.findUnique({ where: { id: params.id } })
      if (!request) {
        return NextResponse.json({ error: 'Leave request not found' }, { status: 404 })
      }

      const updateData: any = {}
      if (isPlanned !== undefined) updateData.isPlanned = isPlanned
      if (approvedDays !== undefined) updateData.days = approvedDays

      if (Object.keys(updateData).length === 0) {
        return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
      }

      const updated = await prisma.leaveRequest.update({
        where: { id: params.id },
        data: updateData,
      })

      return NextResponse.json({ success: true, leaveRequest: updated })
    } catch (error) {
      console.error('Leave request update error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
