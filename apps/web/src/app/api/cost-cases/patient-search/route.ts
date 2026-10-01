import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { withApricotLockRetry, searchPatients } from '@/lib/apricot/client'
import { toCleanPatients, assertNoPiiPatient, type CleanPatient } from '@/lib/apricot/sanitize'
import { listApricotAccounts, withApricotAccount } from '@/lib/apricot/account'

// ============================================================
// GET /api/cost-cases/patient-search — Search Apricot patients
// Perms: cost_entry | provider_payout (Y4)
// Query: ?keyword=
// ★ keyword min 6 chars; max 20 results; PII whitelist only
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
    // ★ cwm-apricotty-20261001：逐個 Apricot 帳號搵（青衣病人喺另一個帳號）—— 每個病人標 account，
    //   之後 bill-search 帶返同一個帳號。一個帳號失敗（例如青衣 token 未寫）唔阻其他帳號；全部失敗先報錯。
    const accounts = await listApricotAccounts()
    const patients: CleanPatient[] = []
    const errors: unknown[] = []
    for (const account of accounts) {
      try {
        const raw = await withApricotAccount(account, () => withApricotLockRetry(() => searchPatients(keyword)))
        for (const p of toCleanPatients(raw)) patients.push({ ...p, account })
      } catch (e) {
        errors.push(e)
        console.warn(`[patient-search] 帳號 ${account} 搜尋失敗`, (e as any)?.message)
      }
    }
    if (errors.length === accounts.length) throw errors[0]
    const top = patients.slice(0, 20)
    assertNoPiiPatient(top)
    return jsonNoStore({ patients: top })
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
