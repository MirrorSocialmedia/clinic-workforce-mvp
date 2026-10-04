// ============================================================
// ★ cwm-chequetpl-20261004：/api/cheque-sheet-templates — 出糧總表自訂模版（OWNER only，見 config.ts）
//   GET  列出模版；POST 新增 { name, config? }（config 冇 = NEW_TEMPLATE_DEFAULT）
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { NEW_TEMPLATE_DEFAULT, normalizeSheetConfig, cleanTemplateName } from '@/lib/cheque-sheet/config'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  return handleRoute('cheque-sheet-templates', async () => {
    const rows = await prisma.chequeSheetTemplate.findMany({ orderBy: { createdAt: 'asc' } })
    return jsonNoStore({
      templates: rows.map(r => {
        let config = NEW_TEMPLATE_DEFAULT
        try { config = normalizeSheetConfig(JSON.parse(r.configJson)) } catch { /* 壞咗用預設 */ }
        return { id: r.id, name: r.name, config, updatedAt: r.updatedAt }
      }),
    })
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheque-sheet-templates', async () => {
    const body = await req.json().catch(() => ({} as any))
    const name = cleanTemplateName(body.name)
    if (!name) return jsonNoStore({ error: '請填模版名稱（最多 30 字）' }, { status: 400 })
    const config = body.config ? normalizeSheetConfig(body.config) : NEW_TEMPLATE_DEFAULT
    const row = await prisma.chequeSheetTemplate.create({ data: { name, configJson: JSON.stringify(config) } })
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'CHEQUE_SHEET_TEMPLATE_UPDATE', entity: 'ChequeSheetTemplate', entityId: row.id,
        notes: `新增出糧總表模版「${name}」`, afterJson: row.configJson,
      },
    })
    return jsonNoStore({ ok: true, id: row.id })
  })
}
