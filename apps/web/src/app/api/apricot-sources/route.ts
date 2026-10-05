// ============================================================
// ★ cwm-datasource-20261003：/api/apricot-sources — 資料來源設定（OWNER only，見 config.ts）
//   GET  全部來源（顯示名、編號格式、服務診所、憑證狀態 —— 永遠唔回憑證內容）
//   POST 新增來源（SaaS：接新 Apricot 帳號）{ displayName, patientCodePattern? } → 內部代號自動生成
//   PUT  改顯示名／編號格式 { account, displayName, patientCodePattern }
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { listSources, isKnownSource } from '@/lib/apricot/sources'
import { normalizeCodePattern, nextSourceAccount } from '@/lib/apricot/source-pure'
import { normalizeApricotAccount } from '@/lib/apricot/account'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  return handleRoute('apricot-sources', async () => jsonNoStore({ sources: await listSources() }))
}

function cleanName(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s && s.length <= 40 ? s : null
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('apricot-sources', async () => {
    const body = await req.json().catch(() => ({} as any))
    const displayName = cleanName(body.displayName)
    if (!displayName) return jsonNoStore({ error: '請填顯示名（最多 40 字）' }, { status: 400 })
    const existing = (await listSources()).map(s => s.account)
    const account = nextSourceAccount(existing)
    const row = await prisma.apricotSource.create({
      data: { account, displayName, patientCodePattern: normalizeCodePattern(body.patientCodePattern) },
    })
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'APRICOT_SOURCE_UPDATE', entity: 'ApricotSource', entityId: row.id,
        notes: `新增資料來源「${displayName}」`,
        afterJson: JSON.stringify({ account, displayName, patientCodePattern: row.patientCodePattern }),
      },
    })
    return jsonNoStore({ ok: true, account })
  })
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('apricot-sources', async () => {
    const body = await req.json().catch(() => ({} as any))
    const account = normalizeApricotAccount(body.account)
    if (typeof body.account !== 'string' || !(await isKnownSource(account))) {
      return jsonNoStore({ error: '搵唔到呢個資料來源' }, { status: 404 })
    }
    // 顯示名留空 = 用返診所名（存空字串會令 listSources 當「冇自訂」）
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
    if (displayName.length > 40) return jsonNoStore({ error: '顯示名最多 40 字' }, { status: 400 })
    const patientCodePattern = normalizeCodePattern(body.patientCodePattern)
    const before = await prisma.apricotSource.findUnique({ where: { account } })
    const row = await prisma.apricotSource.upsert({
      where: { account },
      update: { displayName, patientCodePattern },
      create: { account, displayName, patientCodePattern },
    })
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'APRICOT_SOURCE_UPDATE', entity: 'ApricotSource', entityId: row.id,
        notes: `資料來源設定：顯示名「${displayName || '（用診所名）'}」、編號格式 ${patientCodePattern ?? '不限'}`,
        beforeJson: before ? JSON.stringify({ displayName: before.displayName, patientCodePattern: before.patientCodePattern }) : null,
        afterJson: JSON.stringify({ account, displayName, patientCodePattern }),
      },
    })
    return jsonNoStore({ ok: true })
  })
}
