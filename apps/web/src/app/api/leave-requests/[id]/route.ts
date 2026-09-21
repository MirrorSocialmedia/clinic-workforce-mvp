export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { requireAuth, isAuthError, assertClinicAccess } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { createNotification } from '@/lib/notification'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { balanceYearFor, allowsNegativeBalance, consumesQuota } from '@/lib/leave-types'
import { lockEmployee, HttpError, toHttpResponse } from '@/lib/emp-lock'
import { assertMonthsUnlockedTx, monthsInRange } from '@/lib/payroll-lock'

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

    // ★ 2026-08-04: 審批前檢查餘額（唔可以先寫 APPROVED 後查）
    if (action === 'APPROVE') {
      const systemKey = request.leaveType?.systemKey ?? ''
      const isNoQuota = ['SICK', 'UNPAID_LEAVE'].includes(systemKey)

      if (!isNoQuota) {
        const leaveYear = balanceYearFor(systemKey, new Date(request.startDate))
        const bal = await prisma.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: {
              employeeId: request.employeeId,
              leaveTypeId: request.leaveTypeId,
              year: leaveYear,
            },
          },
        })
        // allowsNegativeBalance (年假/休息日) 唔擋，其餘餘額不足 → 400
        if (!bal && !allowsNegativeBalance(systemKey)) {
          return NextResponse.json(
            { error: `Insufficient leave balance. No balance record found.` },
            { status: 400 }
          )
        }
        if (bal && bal.remaining < request.days && !allowsNegativeBalance(systemKey)) {
          return NextResponse.json(
            { error: `Insufficient leave balance. Remaining: ${bal.remaining} days` },
            { status: 400 }
          )
        }
      }
    }

    // ★ 2026-08-04: $transaction 包住 status + 扣額度
    // ★ cwm-money P2-1：where 帶 status 防雙擊／524 重試雙寫（P2025 → 409）
    let updated
    try {
      updated = await prisma.$transaction(async (tx) => {
        await lockEmployee(tx, request.employeeId)
        // ★ Stage 4A（D1 硬鎖）：只限 APPROVED（REJECT 唔影響計糧）
        if (status === 'APPROVED') {
          await assertMonthsUnlockedTx(tx, {
            actorId: session.userId, employeeId: request.employeeId, what: '批核假期',
            months: monthsInRange(toHKDateStr(request.startDate), toHKDateStr(request.endDate || request.startDate)),
          })
          // mutex：喺鎖入面再查（:58-76 保留做 fast-fail）
          const c = await tx.shift.findFirst({ where: {
            employeeId: request.employeeId, status: { not: 'CANCELLED' },
            date: {
              gte: new Date(`${toHKDateStr(request.startDate)}T00:00:00+08:00`),
              lte: new Date(`${toHKDateStr(request.endDate || request.startDate)}T23:59:59+08:00`),
            } } })
          if (c) throw new HttpError(400, `該員工在假期範圍內已有排班（${toHKDateStr(c.date)}），請先移除排班或改假期日期`)
        }
        const u = await tx.leaveRequest.update({
          where: { id: requestId, status: 'PENDING' },
          data: { status: status as any, approverId: session.userId, approvedAt: new Date() },
        })
        if (status === 'APPROVED' && consumesQuota(request.leaveType)) {
          const systemKey = request.leaveType?.systemKey ?? null
          const year = balanceYearFor(systemKey, new Date(request.startDate))
          const key = { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year }
          if (allowsNegativeBalance(systemKey)) {
            // 可預支：冇 row 就建（同 POST :262-270 一致）—— 唔再「APPROVED 但冇扣」
            await tx.leaveBalance.upsert({
              where: { employeeId_leaveTypeId_year: key },
              create: { ...key, entitled: 0, used: request.days, remaining: -request.days },
              update: { used: { increment: request.days }, remaining: { decrement: request.days } },
            })
          } else {
            // 唔准負：條件扣，count≠1 = 冇 row 或唔夠 → rollback
            const r = await tx.leaveBalance.updateMany({
              where: { ...key, remaining: { gte: request.days } },
              data: { used: { increment: request.days }, remaining: { decrement: request.days } },
            })
            if (r.count !== 1) throw new HttpError(400, `${request.leaveType.name}餘額不足或未設定額度`)
          }
        }
        // ★ Stage 2.3：通知入 tx（同狀態同生死，outbox 語義）
        await createNotification({
          employeeId: request.employeeId,
          type: status === 'APPROVED' ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED',
          content: status === 'APPROVED'
            ? `Your ${request.leaveType.name} request (${request.days} days) has been approved.`
            : `Your ${request.leaveType.name} request (${request.days} days) has been rejected.${notes ? ` Reason: ${notes}` : ''}`,
          relatedEntity: 'LeaveRequest',
          relatedId: request.id,
        }, tx)
        // ★ Stage 2.4：失效入 tx（失敗 = rollback，唔再只 log）
        if (status === 'APPROVED') {
          await invalidateTimeBankFrom(request.employeeId, new Date(request.startDate), tx)
        }
        return u
      })
    } catch (e: any) {
      { const r = toHttpResponse(e); if (r) return r }
      if (e?.code === 'P2025') return NextResponse.json({ error: '呢張假期申請已經有人處理咗' }, { status: 409 })
      throw e
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
        include: { leaveType: { select: { systemKey: true, name: true } } },
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

      // ★ cwm-money P2-1：delete + 還額度同一 transaction（先 delete 後 refund），重試 → P2025 → 409
      await prisma.$transaction(async (tx) => {
        // ★ Stage 4A（D1 硬鎖）：先鎖人再查已出糧月份
        await lockEmployee(tx, request.employeeId)
        if (request.status === 'APPROVED') {
          await assertMonthsUnlockedTx(tx, {
            actorId: session.userId, employeeId: request.employeeId, what: '刪除已批假期',
            months: monthsInRange(toHKDateStr(request.startDate), toHKDateStr(request.endDate || request.startDate)),
          })
        }
        await tx.leaveRequest.delete({ where: { id: requestId, status: request.status } })

        if (request.status === 'APPROVED' && consumesQuota(request.leaveType)) {
          // ★ 累積制假期用 year = 0（2026-08-04 修）
          const leaveYear = balanceYearFor(request.leaveType?.systemKey, new Date(request.startDate))
          const r = await tx.leaveBalance.updateMany({
            where: {
              employeeId: request.employeeId,
              leaveTypeId: request.leaveTypeId,
              year: leaveYear,
            },
            data: { used: { decrement: request.days }, remaining: { increment: request.days } },
          })

          // ★ 唔好靜靜吞 —— 還唔到額度係資料錯誤，一定要留痕
          if (r.count === 0) {
            console.error(
              `[leave-delete] ⛔ 還額度失敗：employeeId=${request.employeeId} ` +
              `leaveTypeId=${request.leaveTypeId} year=${leaveYear} days=${request.days}`,
            )
          }
        }

        // ★ Stage 2.3：假期取消通知（只係已批嘅假先算「取消」）
        if (request.status === 'APPROVED') {
          await createNotification({
            employeeId: request.employeeId,
            type: 'LEAVE_CANCELLED',
            content: `你 ${toHKDateStr(request.startDate)} 嘅${request.leaveType?.name ?? '假期'}已被取消`,
            relatedEntity: 'LeaveRequest',
            relatedId: request.id,
          }, tx)
        }
        // ★ Stage 2.4：失效入 tx（失敗 = rollback，唔再只 log）
        await invalidateTimeBankFrom(request.employeeId, new Date(request.startDate), tx)
      })

      return NextResponse.json({ success: true })
    } catch (error) {
      // ★ cwm-money P2-1：已經刪咗（雙擊／524 重試）→ 409
      if ((error as any)?.code === 'P2025') {
        return NextResponse.json({ error: '呢張假期已經刪咗' }, { status: 409 })
      }
      // ★ Stage 4A：HttpError（409 PAYROLL_LOCKED 等）→ response
      { const r = toHttpResponse(error); if (r) return r }
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

      // ★ Stage 4A（D1 硬鎖）：update 包入 tx（先鎖人 + 已出糧月份檢查）
      const updated = await prisma.$transaction(async (tx) => {
        await lockEmployee(tx, request.employeeId)
        if (request.status === 'APPROVED') {
          await assertMonthsUnlockedTx(tx, { actorId: session.userId, employeeId: request.employeeId, what: '修改已批假期',
            months: monthsInRange(toHKDateStr(request.startDate), toHKDateStr(request.endDate || request.startDate)) })
        }
        return tx.leaveRequest.update({ where: { id: params.id }, data: updateData })
      })

      // ★ audit: LeaveRequest 變更（PATCH 唔啱入 Prisma extension auto-audit）
      await prisma.auditLog.create({
        data: {
          action: 'LEAVE_REQUEST_PATCH',
          entity: 'LeaveRequest',
          entityId: params.id,
          actorId: session.userId,
          notes: `PATCH LeaveRequest: isPlanned=${isPlanned}, approvedDays=${approvedDays}`,
          ipAddress: req.headers.get('x-forwarded-for') || undefined,
        },
      })

      return NextResponse.json({ success: true, leaveRequest: updated })
    } catch (error) {
      // ★ Stage 4A：HttpError（409 PAYROLL_LOCKED 等）→ response
      { const r = toHttpResponse(error); if (r) return r }
      console.error('Leave request update error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
