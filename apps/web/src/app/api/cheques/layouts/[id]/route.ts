// ============================================================
// ★ cwm-chequeprint-20261005：PUT /api/cheques/layouts/:id — 支票版面／校準／打印機模式（只限老闆）
// ownership-ok: 版面全公司共用、冇擁有者；RBAC 只准 OWNER（config.ts，冇 perm override）
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { normalizeFields } from '@/lib/cheque-print/layout'

const clampOff = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(-30, Math.min(30, Math.round(n * 10) / 10)) : 0
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheques-layouts-id', async () => {
    const before = await prisma.chequeLayout.findUnique({ where: { id: params.id } })
    if (!before) return jsonNoStore({ error: '搵唔到呢個版面' }, { status: 404 })
    const b = await req.json().catch(() => ({} as any))
    const data = {
      name: typeof b?.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 30) : before.name,
      fieldsJson: b?.fields ? JSON.stringify(normalizeFields(b.fields)) : before.fieldsJson,
      offsetXmm: b?.offsetXmm !== undefined ? clampOff(b.offsetXmm) : before.offsetXmm,
      offsetYmm: b?.offsetYmm !== undefined ? clampOff(b.offsetYmm) : before.offsetYmm,
      printerMode: b?.printerMode === 'TEXT' || b?.printerMode === 'ESCP' ? b.printerMode : before.printerMode,
    }
    await prisma.chequeLayout.update({ where: { id: params.id }, data })
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'CHEQUE_SETTING_UPDATE', entity: 'ChequeLayout', entityId: params.id,
        notes: `支票版面「${data.name}」`,
        beforeJson: JSON.stringify({ fieldsJson: before.fieldsJson, offsetXmm: before.offsetXmm, offsetYmm: before.offsetYmm, printerMode: before.printerMode }),
        afterJson: JSON.stringify(data),
      },
    })
    return jsonNoStore({ ok: true })
  })
}
