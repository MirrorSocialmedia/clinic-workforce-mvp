// ★ cwm-datasource-20261003：GET /api/apricot-sources/health — 儀表板警告用（OWNER only）
//   只回有問題、而且有店用緊嘅來源（新開未接店嘅來源唔煩人）
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { listSources } from '@/lib/apricot/sources'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  return handleRoute('apricot-sources/health', async () => {
    const alerts = (await listSources())
      .filter(s => s.clinics.length > 0 && s.credential.health.level !== 'ok')
      .map(s => ({ displayName: s.displayName, level: s.credential.health.level, text: s.credential.health.text }))
    return jsonNoStore({ alerts })
  })
}
