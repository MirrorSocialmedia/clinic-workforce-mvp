// ============================================================
// ★ cwm-chequemanual-20261013：POST /api/cheques/manual — 新增手動票（只限老闆）
//   body { accountId, clinicId, month, payeeName, amount, purpose }
//   出票診所必填，而且要係用緊呢本支票簿嘅診所。規則見 lib/cheque-print/manual.ts。
// ownership-ok: 支票全公司共用；RBAC 只准 OWNER（config.ts，冇 perm override）
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { createManualCheque, ManualChequeError, validateManualInput } from '@/lib/cheque-print/manual'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-manual-create', async () => {
    const b = await req.json().catch(() => ({} as any))
    const v = validateManualInput(b)
    if (!v.ok) return jsonNoStore({ error: v.error }, { status: 400 })
    try {
      const row = await createManualCheque(prisma, v.data, b?.month, session.userId)
      return jsonNoStore({ ok: true, id: row.id })
    } catch (e) {
      if (e instanceof ManualChequeError) return jsonNoStore({ error: e.message }, { status: e.status })
      throw e
    }
  })
}
