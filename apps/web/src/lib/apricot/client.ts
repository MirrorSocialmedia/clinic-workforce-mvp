import { loadCreds, saveCreds, markError, type ApricotCreds } from './token'

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
  if (res.status >= 500) throw new Error(`APRICOT_HTTP_${res.status}`)
  if (!res.ok) throw new Error(`APRICOT_HTTP_${res.status}`)
  return res.json()
}
