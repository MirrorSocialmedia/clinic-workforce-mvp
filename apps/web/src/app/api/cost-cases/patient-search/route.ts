import { NextRequest } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { withApricotLockRetry, searchPatients } from '@/lib/apricot/client'
import { toCleanPatients, type CleanPatient } from '@/lib/apricot/sanitize'

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
    return jsonNoStore({ patients })
  } catch (e: any) {
    const msg = e.message || ''
    if (msg === 'APRICOT_BUSY') {
      return jsonNoStore({ error: 'Apricot 忙碌，請稍後重試' }, { status: 503 })
    }
    return jsonNoStore({ error: '搜尋失敗' }, { status: 500 })
  }
}
