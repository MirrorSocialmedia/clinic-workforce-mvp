// ============================================================
// External API v1 守門 helper（MD §A.2）— cw-extapi-20260823-a1
//
// clinic-workforce 對外（wa-inbox 等）嘅唯一 API 守門：
//   1) X-Api-Key：sha256 後逐行 timingSafeEqual（DB ExternalApiKey，只存 hash）
//   2) scope 檢查：key 嘅 scopes 必須包含該 endpoint 嘅 scope
//   3) token bucket 限流：60 req burst、1 req/s 持續（per key name，in-memory）
//   4) withExternalAudit：統一錯誤形狀 { error, code } + 計 latency + 寫
//      ExternalApiAudit（零 PII：keyName/pathname/status/latencyMs）
//      5xx 一律洩 generic message（唔洩內部 error 內容）
//
// 唔入 JWT/RBAC（iron law：RBAC 表零改動）— 呢條 lane 只走 API key。
//
// 偏離 MD 偽碼（報告已註記）：withExternalAudit 簽名係
//   (req, path, handler) 而唔係 (keyName, path, fn) —— 因為 401 時根本
//   唔存在 keyName；handler 經 ctx.setKey(name) 登記過關嘅 key 名。
// ============================================================

import { createHash, timingSafeEqual } from 'node:crypto'
import { basePrisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

/** 外部 API 語義錯誤（4xx）。5xx 唔用呢個 class（withExternalAudit 統一兜底）。 */
export class ExternalApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    /** 額外 response body 欄位（cwi-refresh-20260831：429 retryAfterSec） */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ExternalApiError'
  }
}

export interface ExternalKeyRow {
  id: string
  name: string
  scopes: string[]
  active: boolean
  lastUsedAt: Date | null
}

/** token bucket 參數（MD §A.2：60 req burst，1 req/s 持續） */
export const EXTERNAL_RATE = { capacity: 60, refillPerSec: 1 }

// per-key token bucket（in-memory 夠用：單 process + 同機調用；重啟即清，MD 認可）
const buckets = new Map<string, { tokens: number; ts: number }>()

/** 測試用：清空 rate bucket（in-memory state 唔好跨 case 泄漏） */
export function resetExternalRateBuckets(): void {
  buckets.clear()
}

function takeToken(key: string, rate: { capacity: number; refillPerSec: number }): boolean {
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) {
    b = { tokens: rate.capacity, ts: now }
    buckets.set(key, b)
  } else {
    b.tokens = Math.min(rate.capacity, b.tokens + ((now - b.ts) / 1000) * rate.refillPerSec)
    b.ts = now
  }
  if (b.tokens >= 1) {
    b.tokens -= 1
    return true
  }
  return false
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

interface KeyHeaderSource {
  headers: { get(name: string): string | null }
}

// cwi-refresh-20260831 §2：availability/refresh 專屬限流 —
// 每 clinic 每 60 秒 1 次（capacity 1 / refill 1 per 60s）。
// 同 buckets Map（resetExternalRateBuckets 一併清）；key 用 *resolved clinic id*
// 而非 caller 傳入字串 — 防 shortName/cuid 兩種寫法繞過 bucket。
const REFRESH_RATE = { capacity: 1, refillPerSec: 1 / 60 }

export type RefreshTokenResult = { ok: true } | { ok: false; retryAfterSec: number }

/** 取一個 refresh token；攞唔到回 retryAfterSec（ceil，最小 1 秒）。唔排隊。 */
export function takeRefreshToken(clinicId: string): RefreshTokenResult {
  const key = `refresh:${clinicId}`
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) {
    b = { tokens: REFRESH_RATE.capacity, ts: now }
    buckets.set(key, b)
  } else {
    b.tokens = Math.min(REFRESH_RATE.capacity, b.tokens + ((now - b.ts) / 1000) * REFRESH_RATE.refillPerSec)
    b.ts = now
  }
  if (b.tokens >= 1) {
    b.tokens -= 1
    return { ok: true }
  }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / REFRESH_RATE.refillPerSec)) }
}

/**
 * 外部 API key 守門（MD §A.2 原樣邏輯）：
 *   冇 key → 401；hash 對唔到任何 active key → 401；scope 冇授予 → 403；
 *   超過 rate → 429。過關 → 回傳 key row（caller 用 name 登記 audit）+
 *   fire-and-forget 更新 lastUsedAt（update 失敗唔阻請求）。
 */
export async function requireExternalKey(
  req: KeyHeaderSource,
  scope: string,
): Promise<ExternalKeyRow> {
  const key = req.headers.get('x-api-key') ?? ''
  if (!key) throw new ExternalApiError(401, 'missing key', 'UNAUTHORIZED')
  const hash = sha256Hex(key)
  const rows = await basePrisma.externalApiKey.findMany({ where: { active: true } })
  for (const r of rows) {
    // 同長度先 timingSafeEqual（hash 固定 64 hex，純防御）
    if (r.keyHash.length === hash.length && timingSafeEqual(Buffer.from(r.keyHash), Buffer.from(hash))) {
      if (!r.scopes.includes(scope)) {
        throw new ExternalApiError(403, `scope ${scope} not granted`, 'FORBIDDEN')
      }
      if (!takeToken(r.name, EXTERNAL_RATE)) {
        throw new ExternalApiError(429, 'rate limited', 'RATE_LIMITED')
      }
      basePrisma.externalApiKey
        .update({ where: { id: r.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {})
      return r
    }
  }
  throw new ExternalApiError(401, 'invalid key', 'UNAUTHORIZED')
}

/**
 * withExternalAudit ctx —— handler 過關後 call setKey(name) 登記 audit 用 key 名。
 * （MD 偏離註記：key 名喺 auth 之後先知道，故用 ctx 而非參數傳入。）
 */
export interface ExternalApiContext {
  setKey(name: string | null): void
  keyName: string | null
}

/**
 * 統一 audit wrapper（MD §A.2）：
 *   - 計 latency（ms），寫 ExternalApiAudit（keyName 缺省 'anonymous' — 零 PII）
 *   - ExternalApiError → 原 status + { error: message, code }
 *   - 其他錯誤 → 500 { error: 'internal error', code: 'INTERNAL' }（洩 generic，
 *     內部 error 只 console.error，唔入 response body）
 *   - audit 寫入失敗唔阻回應（console.error 跟進）
 */
export async function withExternalAudit(
  req: Request,
  path: string,
  handler: (ctx: ExternalApiContext) => Promise<Response>,
): Promise<Response> {
  const t0 = Date.now()
  let keyName: string | null = null
  let status = 500
  const ctx: ExternalApiContext = {
    keyName: null,
    setKey: (n) => { keyName = n },
  }
  try {
    const res = await handler(ctx)
    status = res.status
    return res
  } catch (e) {
    if (e instanceof ExternalApiError) {
      status = e.status
      return jsonNoStore({ error: e.message, code: e.code, ...(e.extra ?? {}) }, { status: e.status })
    }
    console.error(`[external-api] ${path} 未預期錯誤（response 只回 generic）:`, e)
    return jsonNoStore({ error: 'internal error', code: 'INTERNAL' }, { status: 500 })
  } finally {
    const latencyMs = Date.now() - t0
    try {
      await basePrisma.externalApiAudit.create({
        data: {
          keyName: keyName ?? 'anonymous',
          path,
          status,
          latencyMs,
        },
      })
    } catch (err) {
      console.error('[external-api] audit 寫入失敗', err)
    }
  }
}

// ============================================================
// 日期參數工具（external API query 驗證共用）
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 'YYYY-MM-DD' 格式 + 真實日期（2026-02-30 咁嘅偽日期會拒） */
export function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d)
  const r = new Date(t)
  return (
    r.getUTCFullYear() === y &&
    r.getUTCMonth() === m - 1 &&
    r.getUTCDate() === d
  )
}

/** to - from 日數（純 UTC 日曆差，唔涉時區） */
export function dateDiffDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}
