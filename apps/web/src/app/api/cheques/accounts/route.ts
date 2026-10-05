// ============================================================
// ★ cwm-chequeprint-20261005：POST /api/cheques/accounts — 新增出票戶口（只限老闆）
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { parseAccountBody } from '@/lib/cheque-print/account-body'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-accounts', async () => {
    const parsed = parseAccountBody(await req.json().catch(() => ({})))
    if (!parsed.ok) return jsonNoStore({ error: parsed.error }, { status: 400 })
    const { clinicIds, ...data } = parsed.data
    const row = await prisma.$transaction(async tx => {
      const a = await tx.chequeAccount.create({ data })
      for (const clinicId of clinicIds) {
        await tx.chequeAccountClinic.upsert({ where: { clinicId }, create: { clinicId, accountId: a.id }, update: { accountId: a.id } })
      }
      await tx.auditLog.create({
        data: {
          actorId: session.userId, action: 'CHEQUE_SETTING_UPDATE', entity: 'ChequeAccount', entityId: a.id,
          notes: `新增出票戶口「${a.label}」`, afterJson: JSON.stringify({ ...data, clinicIds }),
        },
      })
      return a
    })
    return jsonNoStore({ ok: true, id: row.id })
  })
}
