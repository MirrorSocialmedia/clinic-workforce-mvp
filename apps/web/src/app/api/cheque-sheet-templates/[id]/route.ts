// ★ cwm-chequetpl-20261004：PUT／DELETE /api/cheque-sheet-templates/:id（OWNER only）
// ownership-ok: 模版全公司共用、冇擁有者；RBAC 只准 OWNER（config.ts，冇 perm override）
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { normalizeSheetConfig, cleanTemplateName } from '@/lib/cheque-sheet/config'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheque-sheet-templates/:id', async () => {
    const before = await prisma.chequeSheetTemplate.findUnique({ where: { id: params.id } })
    if (!before) return jsonNoStore({ error: '搵唔到呢個模版' }, { status: 404 })
    const body = await req.json().catch(() => ({} as any))
    const name = body.name === undefined ? before.name : cleanTemplateName(body.name)
    if (!name) return jsonNoStore({ error: '請填模版名稱（最多 30 字）' }, { status: 400 })
    const configJson = body.config === undefined ? before.configJson : JSON.stringify(normalizeSheetConfig(body.config))
    await prisma.chequeSheetTemplate.update({ where: { id: before.id }, data: { name, configJson } })
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'CHEQUE_SHEET_TEMPLATE_UPDATE', entity: 'ChequeSheetTemplate', entityId: before.id,
        notes: `更新出糧總表模版「${name}」`, beforeJson: before.configJson, afterJson: configJson,
      },
    })
    return jsonNoStore({ ok: true })
  })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheque-sheet-templates/:id', async () => {
    const before = await prisma.chequeSheetTemplate.findUnique({ where: { id: params.id } })
    if (!before) return jsonNoStore({ error: '搵唔到呢個模版' }, { status: 404 })
    await prisma.chequeSheetTemplate.delete({ where: { id: before.id } })
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'CHEQUE_SHEET_TEMPLATE_UPDATE', entity: 'ChequeSheetTemplate', entityId: before.id,
        notes: `刪除出糧總表模版「${before.name}」`, beforeJson: before.configJson,
      },
    })
    return jsonNoStore({ ok: true })
  })
}
