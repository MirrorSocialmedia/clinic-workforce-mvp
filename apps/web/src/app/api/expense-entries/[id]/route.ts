import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

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
  const { session } = permCheck

  const { id } = await params
  const entry = await prisma.expenseEntry.findUnique({ where: { id } })

  if (!entry) {
    return NextResponse.json({ error: '不存在' }, { status: 404 })
  }

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
    },
  } as any)

  await prisma.expenseEntry.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
