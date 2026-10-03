// ★ cwm-datasource-20261003：POST /api/apricot-sources/test — 測試連線（OWNER only）{ account }
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { isKnownSource, testSourceConnection } from '@/lib/apricot/sources'
import { normalizeApricotAccount } from '@/lib/apricot/account'
import { sourceErrorText } from '@/lib/patient-search'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  return handleRoute('apricot-sources/test', async () => {
    const body = await req.json().catch(() => ({} as any))
    const account = normalizeApricotAccount(body.account)
    if (typeof body.account !== 'string' || !(await isKnownSource(account))) {
      return jsonNoStore({ error: '搵唔到呢個資料來源' }, { status: 404 })
    }
    const r = await testSourceConnection(account)
    return jsonNoStore({ ok: r.ok, text: r.ok ? '連線成功' : sourceErrorText(r.error) })
  })
}
