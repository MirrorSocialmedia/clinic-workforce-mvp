// ============================================================
// ★ cwm-datasource-20261003：資料來源設定 —— 純函數（冇 prisma，可單元測試；前端亦可 import）
// ============================================================

export type CodePattern = 'NUMERIC' | 'PREFIXED'

export const CODE_PATTERN_LABEL: Record<CodePattern, string> = {
  NUMERIC: '純數字（例：003213）',
  PREFIXED: '英文前綴＋數字（例：TW007446）',
}

export function normalizeCodePattern(v: unknown): CodePattern | null {
  return v === 'NUMERIC' || v === 'PREFIXED' ? v : null
}

/** 搜尋字眼似邊種編號（用嚟將格式吻合嘅來源排前；唔吻合都照搜） */
export function keywordPattern(keyword: string): CodePattern | null {
  const k = keyword.trim()
  if (/^\d+$/.test(k)) return 'NUMERIC'
  if (/^[A-Za-z]{1,6}\d+$/.test(k)) return 'PREFIXED'
  return null
}

/** 「TKW, TK、tw」→ ['TKW','TK','TW']（大楷、去重、只准 1–6 個英文字母） */
export function parsePrefixList(s: string | null | undefined): string[] {
  const out: string[] = []
  for (const part of (s ?? '').split(/[\s,，、;；/]+/)) {
    const p = part.trim().toUpperCase()
    if (/^[A-Z]{1,6}$/.test(p) && !out.includes(p)) out.push(p)
  }
  return out
}

export type ParsedCreds = { accessToken: string; refreshToken: string; iat: string }

/**
 * 解析貼入嚟嘅憑證。支援：
 *   ① 三格分開填（accessToken / refreshToken / iat）
 *   ② 一大段文字：瀏覽器「Copy request headers」嘅 `cookie: access_token=…; refresh_token=…; iat=…`、
 *      或者 DevTools Cookies 表逐行複製（名稱<Tab>值…）
 * 分開填嘅格優先；其餘由大段文字補。
 */
export function parseCredentialInput(input: {
  cookie?: unknown; accessToken?: unknown; refreshToken?: unknown; iat?: unknown
}): { ok: true; creds: ParsedCreds } | { ok: false; error: string } {
  const text = typeof input.cookie === 'string' ? input.cookie : ''
  const pick = (name: string): string => {
    // 名稱後面接 = 或 Tab／空格（DevTools 表格），值去到 ; 或空白為止
    const m = text.match(new RegExp(`(?:^|[\\s;"'])${name}(?:\\s*=\\s*|\\t+)([^\\s;"']+)`))
    return m ? m[1] : ''
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const accessToken = str(input.accessToken) || pick('access_token')
  const refreshToken = str(input.refreshToken) || pick('refresh_token')
  const iat = str(input.iat) || pick('iat')

  const missing = [!accessToken && 'access_token', !refreshToken && 'refresh_token', !iat && 'iat'].filter(Boolean)
  if (missing.length) return { ok: false, error: `搵唔到 ${missing.join('、')}` }
  if (!/^\d{10}$/.test(iat)) return { ok: false, error: 'iat 應該係 10 位數字' }
  const bad = (v: string) => v.length > 8000 || /[\s;]/.test(v)
  if (bad(accessToken) || bad(refreshToken)) return { ok: false, error: 'token 格式唔啱（有空格或分號），請重新複製' }
  return { ok: true, creds: { accessToken, refreshToken, iat } }
}

export type CredentialRow = {
  lastOkAt: Date | string | null
  lastError: string | null
  refreshExpiry: Date | string | null
}

export type CredentialHealth = {
  level: 'ok' | 'warn' | 'error'
  code: 'OK' | 'MISSING' | 'EXPIRED' | 'EXPIRING' | 'UNVERIFIED' | 'STALE' | 'ERROR'
  text: string
}

const DAY = 86_400_000

/**
 * 憑證健康（設定頁同儀表板警告共用）。
 * ⚠️ 系統排程（sync-availability）24 小時都會用 token，正常情況 refresh 會一直順延；
 *   所以「超過一日冇成功連線」或者「就快過期」都代表有嘢唔妥，要提早講。
 */
export function credentialHealth(row: CredentialRow | null, now: Date = new Date()): CredentialHealth {
  if (!row) return { level: 'error', code: 'MISSING', text: '未設定憑證' }
  const t = (d: Date | string | null) => (d ? new Date(d).getTime() : null)
  const ok = t(row.lastOkAt), exp = t(row.refreshExpiry)
  if (row.lastError?.startsWith('auth failed')) return { level: 'error', code: 'EXPIRED', text: '憑證失效，需要重新授權' }
  if (exp != null && exp <= now.getTime()) return { level: 'error', code: 'EXPIRED', text: '憑證已過期，需要重新授權' }
  if (row.lastError) return { level: 'warn', code: 'ERROR', text: row.lastError.startsWith('rate limited') ? '上次連線被 Apricot 限流（通常會自動恢復）' : '上次連線出錯' }
  if (ok == null) return { level: 'warn', code: 'UNVERIFIED', text: '未驗證 —— 請按「測試連線」' }
  if (exp != null && exp - now.getTime() < 2 * DAY) return { level: 'warn', code: 'EXPIRING', text: '憑證兩日內過期（排程可能停咗）' }
  if (now.getTime() - ok > DAY) return { level: 'warn', code: 'STALE', text: '超過一日冇成功連線（排程可能停咗）' }
  return { level: 'ok', code: 'OK', text: '正常' }
}

/** 新來源內部代號：S2、S3…（唔顯示俾員工；只要唔撞就得） */
export function nextSourceAccount(existing: string[]): string {
  const set = new Set(existing.map(a => a.toUpperCase()))
  for (let i = 2; ; i++) if (!set.has(`S${i}`)) return `S${i}`
}
