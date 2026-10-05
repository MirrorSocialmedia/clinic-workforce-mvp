// ============================================================
// ★ cwm-chequeprint-20261005：PUT /api/cheques/accounts/:id — 改出票戶口／支票簿／用嘅診所（只限老闆）
// ownership-ok: 戶口全公司共用、冇擁有者；RBAC 只准 OWNER（config.ts，冇 perm override）
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { parseAccountBody } from '@/lib/cheque-print/account-body'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-accounts-id', async () => {
    const before = await prisma.chequeAccount.findUnique({ where: { id: params.id } })
    if (!before) return jsonNoStore({ error: '搵唔到呢個戶口' }, { status: 404 })
    const parsed = parseAccountBody(await req.json().catch(() => ({})))
    if (!parsed.ok) return jsonNoStore({ error: parsed.error }, { status: 400 })
    const { clinicIds, ...data } = parsed.data
    const beforeClinics = (await prisma.chequeAccountClinic.findMany({ where: { accountId: params.id } })).map(l => l.clinicId)
    await prisma.$transaction(async tx => {
      await tx.chequeAccount.update({ where: { id: params.id }, data })
      await tx.chequeAccountClinic.deleteMany({ where: { accountId: params.id, clinicId: { notIn: clinicIds } } })
      for (const clinicId of clinicIds) {
        await tx.chequeAccountClinic.upsert({ where: { clinicId }, create: { clinicId, accountId: params.id }, update: { accountId: params.id } })
      }
      await tx.auditLog.create({
        data: {
          actorId: session.userId, action: 'CHEQUE_SETTING_UPDATE', entity: 'ChequeAccount', entityId: params.id,
          notes: `修改出票戶口「${data.label}」`,
          beforeJson: JSON.stringify({ ...before, clinicIds: beforeClinics }),
          afterJson: JSON.stringify({ ...data, clinicIds }),
        },
      })
    })
    return jsonNoStore({ ok: true })
  })
}
