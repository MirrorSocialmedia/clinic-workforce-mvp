// ============================================================
// ★ cwm-chequeprint-20261005：PUT /api/cheques/payees — 醫生／Lab 支票抬頭（只限老闆）
//   body { kind: 'PROVIDER'|'LAB', refId, payeeName }；payeeName 空 = 刪除
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { cleanPayee } from '@/lib/cheque-print/content'

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-payees', async () => {
    const b = await req.json().catch(() => ({} as any))
    const kind = b?.kind === 'PROVIDER' || b?.kind === 'LAB' ? b.kind : null
    const refId = typeof b?.refId === 'string' ? b.refId : ''
    if (!kind || !refId) return jsonNoStore({ error: '參數唔啱' }, { status: 400 })
    const exists = kind === 'PROVIDER'
      ? await prisma.provider.findUnique({ where: { id: refId }, select: { id: true } })
      : await prisma.lab.findUnique({ where: { id: refId }, select: { id: true } })
    if (!exists) return jsonNoStore({ error: '搵唔到' }, { status: 404 })
    const payeeName = cleanPayee(typeof b?.payeeName === 'string' ? b.payeeName : '').slice(0, 80)
    const before = await prisma.chequePayee.findUnique({ where: { kind_refId: { kind, refId } } })
    if (!payeeName) {
      if (before) await prisma.chequePayee.delete({ where: { kind_refId: { kind, refId } } })
    } else {
      await prisma.chequePayee.upsert({
        where: { kind_refId: { kind, refId } },
        create: { kind, refId, payeeName, updatedBy: session.userId },
        update: { payeeName, updatedBy: session.userId },
      })
    }
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'CHEQUE_SETTING_UPDATE', entity: 'ChequePayee', entityId: `${kind}:${refId}`,
        notes: `支票抬頭（${kind === 'PROVIDER' ? '醫生' : 'Lab'}）`, beforeJson: before?.payeeName ?? null, afterJson: payeeName || null,
      },
    })
    return jsonNoStore({ ok: true, payeeName })
  })
}
