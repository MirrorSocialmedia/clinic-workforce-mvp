// ============================================================
// ★ cwm-chequemanual-20261013：手動票改／刪（只限老闆）
//   PUT    /api/cheques/manual/:id  body { accountId, clinicId, payeeName, amount, purpose }（月份唔改）
//   DELETE /api/cheques/manual/:id  （軟刪除）
//   已出票（未作廢）→ 409，要先作廢張票。規則見 lib/cheque-print/manual.ts。
// ownership-ok: 支票全公司共用；RBAC 只准 OWNER（config.ts，冇 perm override）
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { deleteManualCheque, ManualChequeError, updateManualCheque, validateManualInput } from '@/lib/cheque-print/manual'

function mapError(e: unknown) {
  if (e instanceof ManualChequeError) return jsonNoStore({ error: e.message }, { status: e.status })
  throw e
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-manual-update', async () => {
    const b = await req.json().catch(() => ({} as any))
    const v = validateManualInput(b)
    if (!v.ok) return jsonNoStore({ error: v.error }, { status: 400 })
    try {
      const row = await updateManualCheque(prisma, params.id, v.data, session.userId)
      return jsonNoStore({ ok: true, id: row.id })
    } catch (e) {
      return mapError(e)
    }
  })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-manual-delete', async () => {
    try {
      await deleteManualCheque(prisma, params.id, session.userId)
      return jsonNoStore({ ok: true })
    } catch (e) {
      return mapError(e)
    }
  })
}
