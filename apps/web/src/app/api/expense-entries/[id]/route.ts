import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requirePerm, isAuthError, assertClinicAccess } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { createNotification } from '@/lib/notification'
import { getMonthRange } from '@/lib/hk-date'

// ============================================================
// PATCH /api/expense-entries/[id] — 經理審批雜項報銷
// Roles: OWNER, MANAGER, ACCOUNTANT
// Body: { action: 'APPROVE' | 'REJECT', rejectReason?: string }
// ============================================================
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const permCheck = await requirePerm(req, 'payroll_generate')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const body = await req.json()
  const { action, rejectReason } = body
  if (!['APPROVE', 'REJECT'].includes(action)) {
    return jsonNoStore({ error: 'action 必須係 APPROVE 或 REJECT' }, { status: 400 })
  }

  const { id } = await params
  const entry = await prisma.expenseEntry.findUnique({
    where: { id },
    include: {
      employee: {
        select: {
          id: true,
          clinics: { select: { clinicId: true } },
        },
      },
    },
  })
  if (!entry) {
    return jsonNoStore({ error: '搵唔到記錄' }, { status: 404 })
  }
  if (entry.status !== 'PENDING') {
    return jsonNoStore({ error: '已經審批過' }, { status: 409 })
  }

  // 已出糧月份檢查（唔擋，只警告）
  const { start: pm } = getMonthRange(new Date(`${entry.periodMonth}-01T00:00:00+08:00`))
  const locked = await prisma.payrollRun.findFirst({
    where: {
      periodMonth: pm,
      status: { in: ['FINALIZED', 'EXPORTED'] },
    },
    select: { id: true },
  })

  const updated = await prisma.expenseEntry.update({
    where: { id },
    data: {
      status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      reviewedBy: session.userId,
      reviewedAt: new Date(),
      rejectReason: action === 'REJECT' ? (rejectReason ?? null) : null,
    },
  })

  // 通知員工
  await createNotification({
    employeeId: entry.employeeId,
    type: action === 'APPROVE' ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
    content:
      action === 'APPROVE'
        ? `雜項報銷已批准：${entry.description} $${entry.amount}`
        : `雜項報銷已拒絕：${entry.description} $${entry.amount}${rejectReason ? `（${rejectReason}）` : ''}`,
    relatedEntity: 'ExpenseEntry',
    relatedId: entry.id,
  })

  return jsonNoStore({
    entry: updated,
    payrollLocked: locked ? { month: entry.periodMonth } : null,
  })
}

// ============================================================
// DELETE /api/expense-entries/[id] — Delete an expense entry
// Roles: OWNER, MANAGER, ACCOUNTANT (payroll_generate)
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const permCheck = await requirePerm(req, 'payroll_generate')
  if (isAuthError(permCheck)) return permCheck.error
  const { session, scope } = permCheck

  const { id } = await params
  const entry = await prisma.expenseEntry.findUnique({ where: { id } })

  if (!entry) {
    return NextResponse.json({ error: '不存在' }, { status: 404 })
  }

  // ★ IDOR: 先查員工歸屬店
  const emp = await prisma.employee.findUnique({
    where: { id: entry.employeeId },
    select: { homeClinicId: true },
  })
  const denied = assertClinicAccess(scope, session, emp?.homeClinicId)
  if (denied) return denied

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'EXPENSE_DELETE',
      entity: 'ExpenseEntry',
      entityId: id,
      targetEmployeeId: entry.employeeId,
      beforeJson: JSON.stringify({
        amount: entry.amount,
        description: entry.description,
        periodMonth: entry.periodMonth,
      }),
      afterJson: null,
      notes: `取消: ${entry.description} $${Number(entry.amount).toLocaleString()}（${entry.periodMonth}）`,
    },
  } as any)

  await prisma.expenseEntry.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
