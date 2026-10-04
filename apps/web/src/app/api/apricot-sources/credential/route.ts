// ============================================================
// ★ cwm-datasource-20261003：PUT /api/apricot-sources/credential — 網頁貼入新憑證（OWNER only）
//   取代 `docker exec … apricot-set-token.mjs`。
//   { account, cookie? | accessToken?, refreshToken?, iat? } → 加密存 → 即刻測試連線 → 回結果
//   ⚠️ 憑證內容唔 log、唔入 audit、唔回前端；audit 只記「更新咗」同測試結果。
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { isKnownSource, testSourceConnection } from '@/lib/apricot/sources'
import { parseCredentialInput } from '@/lib/apricot/source-pure'
import { normalizeApricotAccount, credentialProviderKey } from '@/lib/apricot/account'
import { setCredsManually } from '@/lib/apricot/token'
import { sourceErrorText } from '@/lib/patient-search'

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('apricot-sources/credential', async () => {
    const body = await req.json().catch(() => ({} as any))
    const account = normalizeApricotAccount(body.account)
    if (typeof body.account !== 'string' || !(await isKnownSource(account))) {
      return jsonNoStore({ error: '搵唔到呢個資料來源' }, { status: 404 })
    }
    const parsed = parseCredentialInput(body)
    if (!parsed.ok) return jsonNoStore({ error: parsed.error }, { status: 400 })

    await setCredsManually(parsed.creds, account)
    const test = await testSourceConnection(account)
    const testText = test.ok ? '連線成功' : sourceErrorText(test.error)

    const row = await prisma.externalCredential.findUnique({ where: { provider: credentialProviderKey(account) }, select: { id: true } })
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'APRICOT_CREDENTIAL_UPDATE', entity: 'ExternalCredential', entityId: row?.id ?? credentialProviderKey(account),
        notes: `更新 Apricot 憑證（${credentialProviderKey(account)}）— 測試：${testText}`,
      },
    })
    return jsonNoStore({ ok: true, test: { ok: test.ok, text: testText } })
  })
}
