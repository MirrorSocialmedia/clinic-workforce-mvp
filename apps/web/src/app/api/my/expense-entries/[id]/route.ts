import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// DELETE /api/my/expense-entries/[id] — 員工刪除自己未審批嘅申請
// ★ 唔準報洩漏（唔屬於自己返 404）
// ★ 已審批嘅記錄唔可以刪
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
    select: { id: true },
  })
  if (!employee) {
    return jsonNoStore({ error: '搵唔到員工檔案' }, { status: 400 })
  }

  const { id } = await params

  const entry = await prisma.expenseEntry.findUnique({ where: { id } })
  if (!entry || entry.employeeId !== employee.id) {
    // ★ 唔洩漏 — 唔屬於自己也返 404
    return jsonNoStore({ error: '搵唔到記錄' }, { status: 404 })
  }
  if (entry.status !== 'PENDING') {
    return jsonNoStore({ error: '已審批嘅記錄唔可以刪，請聯絡經理' }, { status: 409 })
  }

  await prisma.expenseEntry.delete({ where: { id } })
  return jsonNoStore({ ok: true })
}
