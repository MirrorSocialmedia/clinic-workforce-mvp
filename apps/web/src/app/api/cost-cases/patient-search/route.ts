import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { assertNoPiiPatient } from '@/lib/apricot/sanitize'
import { searchPatientsAllSources } from '@/lib/patient-search'

// ============================================================
// GET /api/cost-cases/patient-search — Search Apricot patients
// Perms: cost_entry | provider_payout (Y4)
// Query: ?keyword=
// ★ keyword min 6 chars; max 30 results（各來源公平合併）; PII whitelist only
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const keyword = searchParams.get('keyword')

  if (!keyword || keyword.length < 6) {
    return jsonNoStore({ error: 'keyword 最短 6 字元' }, { status: 400 })
  }

  try {
    // ★ cwm-patientsearch-20261003：統一病人搜尋 —— 全部來源（含青衣）＋本地索引，公平合併，
    //   每個結果帶診所，每個來源回報狀態（之前某來源失敗／冇結果都靜靜消失）
    const { patients, sources } = await searchPatientsAllSources(keyword)
    assertNoPiiPatient(patients)
    return jsonNoStore({ patients, sources })
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
