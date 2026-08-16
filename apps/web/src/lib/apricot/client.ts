import { loadCreds, saveCreds, markError, type ApricotCreds } from './token'
import { hkDateStart, hkDateEnd, toHKDateStr } from '@/lib/hk-date'

const BASE = 'https://apricotvita.com'

export async function apricotCall(path: string, init?: RequestInit): Promise<any> {
  const creds = await loadCreds()
  if (!creds) throw new Error('APRICOT_NOT_CONFIGURED')

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      origin: BASE,
      ...(init?.headers ?? {}),
      cookie: `access_token=${creds.accessToken}; refresh_token=${creds.refreshToken}; iat=${creds.iat}`,
    },
    redirect: 'manual', // ★ 防 302 登入頁
    signal: AbortSignal.timeout(20_000),
  })

  // ★★ 每次都要接住 Set-Cookie —— rotation 喺每個 response 發生
  const setCookies = res.headers.getSetCookie?.() ?? [] // ★ 一定要 getSetCookie()
  if (setCookies.length) {
    const next = { ...creds }
    let changed = false
    let refreshExpiry: Date | undefined
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';')
      const i = pair.indexOf('=')
      if (i <= 0) continue
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim()
      if (name === 'access_token' && value !== next.accessToken) { next.accessToken = value; changed = true }
      if (name === 'iat' && value !== next.iat) { next.iat = value; changed = true }
      if (name === 'refresh_token' && value !== next.refreshToken) {
        next.refreshToken = value; changed = true
        const exp = attrs.find(a => a.trim().toLowerCase().startsWith('expires='))
        if (exp) { const d = new Date(exp.split('=')[1].trim()); if (!isNaN(+d)) refreshExpiry = d }
      }
    }
    if (changed) {
      // ★ 寫入失敗一定要 throw
      await saveCreds(next, refreshExpiry)
    }
  }

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    await markError(`auth failed HTTP ${res.status}`)
    throw new Error('APRICOT_AUTH_EXPIRED') // ★ 唔重試
  }
  if (res.status === 429) {
    await markError('rate limited 429')
    throw new Error('APRICOT_RATE_LIMITED') // ★ 唔重試
  }
  if (!res.ok) {
    // ★ H2: 保留錯誤 body（成功 response 有病人資料，唔准 log）
    let detail = ''
    try { detail = (await res.text()).slice(0, 300) } catch { /* 讀唔到就算 */ }
    console.error('[apricot] HTTP error', { status: res.status, path, detail })
    throw new Error(`APRICOT_HTTP_${res.status}${detail ? `: ${detail}` : ''}`)
  }
  return res.json()
}

// ★ MD-F: Retry wrapper for interactive queries (lock/conflict)
// APRICOT_AUTH_EXPIRED / APRICOT_RATE_LIMITED pass through immediately (no retry)
export async function withApricotLockRetry<T>(fn: () => Promise<T>, tries = 3, delayMs = 700): Promise<T> {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e: any) {
      const msg = e.message || ''
      // Pass through non-retryable errors
      if (msg === 'APRICOT_AUTH_EXPIRED' || msg === 'APRICOT_RATE_LIMITED') throw e
      if ((msg.includes('lock') || msg.includes('LOCK') || msg.includes('busy') || msg.includes('BUSY') || msg.startsWith('APRICOT_HTTP_503')) && i < tries - 1) {
        await new Promise(r => setTimeout(r, delayMs))
        continue
      }
      throw new Error('APRICOT_BUSY')
    }
  }
  throw new Error('APRICOT_BUSY')
}

// ★ MD-F: Search patients by keyword
export async function searchPatients(keyword: string): Promise<any[]> {
  const data = await apricotCall(`/services/aepsmsope/api/clinic-patients?keyword=${encodeURIComponent(keyword)}`)
  return Array.isArray(data) ? data : (data?.list ?? data?.results ?? [])
}

// ★ MD-F: Search bills by patient extId — params[] body format (實測)
export async function searchBillsByPatient(patientExtId: string, months: number): Promise<any[]> {
  const now = new Date()
  const endStr = toHKDateStr(now)
  const from = new Date(now)
  from.setUTCDate(1)
  from.setUTCMonth(from.getUTCMonth() - months)
  const startStr = toHKDateStr(from)

  const qs = new URLSearchParams({
    page: '0', size: '50', sort: 'desc', keyword: '', sortBy: 'billTime',
  })
  const data = await apricotCall(`/services/aepsmsbill/api/bills/search?${qs}`, {
    method: 'POST',
    body: JSON.stringify({
      params: [
        { key: 'startDate', value: hkDateStart(startStr).toISOString() },
        { key: 'endDate', value: hkDateEnd(endStr).toISOString() },
        { key: 'patientCustomerType', value: 'patient' },
        { key: 'patients', details: [patientExtId] }, // ★ details 唔係 value
      ],
    }),
  })
  return Array.isArray(data) ? data : (data?.content ?? data?.list ?? [])
}
