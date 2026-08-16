import { NextRequest } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { withApricotLockRetry, searchPatients } from '@/lib/apricot/client'
import { toCleanPatients, assertNoPiiPatient, type CleanPatient } from '@/lib/apricot/sanitize'

// ============================================================
// GET /api/cost-cases/patient-search — Search Apricot patients
// Perm: cost_entry
// Query: ?keyword=
// ★ keyword min 6 chars; max 20 results; PII whitelist only
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'cost_entry')
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const keyword = searchParams.get('keyword')

  if (!keyword || keyword.length < 6) {
    return jsonNoStore({ error: 'keyword 最短 6 字元' }, { status: 400 })
  }

  try {
    const raw = await withApricotLockRetry(() => searchPatients(keyword))
    const patients: CleanPatient[] = toCleanPatients(raw)
    assertNoPiiPatient(patients)
    return jsonNoStore({ patients })
  } catch (e: any) {
    const msg = e.message || ''
    if (msg === 'APRICOT_BUSY') {
      return jsonNoStore({ error: 'Apricot 忙碌，請稍後重試' }, { status: 503 })
    }
    if (msg.startsWith('APRICOT_HTTP_')) {
      return jsonNoStore({ error: msg }, { status: 502 })
    }
    if (msg === 'APRICOT_AUTH_EXPIRED') {
      return jsonNoStore({ error: 'Apricot 憑證失效，需要重新授權' }, { status: 401 })
    }
    return jsonNoStore({ error: '搜尋失敗' }, { status: 500 })
  }
}
