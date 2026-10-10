/**
 * cwm-labdoc P2 — 讀單 LLM client（§5.2，CWM 側）
 *
 * 經 wa-inbox proxy（`POST $WA_INBOX_LABDOC_URL`）；信封同 clinical/llm-envelope 同一套
 * （AES-256-GCM，AAD = v|kid|ts|nonce|context 五元綁定）；
 * REQ_CONTEXT = "labdoc-extract.v1"，回應 respContext(nonce)（同 W route 逐字一致）。
 *
 * 時限：client 總時限 95 秒（v1.1 §5.2：W 側 85s < CWM 95s < Cloudflare origin 100s）。
 *   用 AbortSignal.timeout(95_000) 包住每次 fetch — 唔單係 timeoutMs。
 *
 * 429 BUSY（W 側 concurrency）：每次重試 **重新 seal 新 envelope**（新 ts + 新 nonce）—
 *   W 側 M-1 後 429 唔消耗 nonce，重試同一信封雖然都係 429，但 re-seal 係雙保險（工單 §1 已定決定 4）。
 *   呢度設計：每次 attempt 都重新 seal（新 nonce）→ 429 重試天然用新 envelope。
 *
 * 成功判定：**result != null**（AI_MOCK 時 reason="mock" 但有 result — 照計成功，§5.2）。
 * result == null 時 reason ∈ breaker_open | llm_error | parse_error | bad_response | truncated | null：
 *   全部當一次失敗（caller 計 attempts；truncated = 輸出撞 max_tokens — 原樣重試無意義，
 *   caller 保守處理：計一次失敗）。
 *
 * env：WA_INBOX_LABDOC_URL + INTERNAL_LLM_SECRET（+ INTERNAL_LLM_KID，預設 k1）。
 *   未設 → 回 null + reason 'not_configured'（runner 全部 EXTRACT_FAILED，extractError='not_configured'，
 *   畫面提示「讀單服務未設定，請人手輸入」）。
 *
 * 測試用 __setLabDocExtractFn(fn) stub（同 clinical __setExtractFn 先例）。
 */
import { seal, open, respContext, type Envelope } from '../clinical/llm-envelope'
import type { LabDocResult } from './schema'

export const REQ_CONTEXT_LABDOC = 'labdoc-extract.v1'
/** v1.1 §5.2：CWM client 總時限 95 秒（包埋重試嘅每次 fetch） */
export const LABDOC_CLIENT_TIMEOUT_MS = 95_000
/** 429 重試間隔上限（跟 clinical：cap 10 秒） */
const BUSY_SLEEP_CAP_MS = 10_000
/** 預設最多打 proxy 嘅次數（caller 可傳；runner 用 3 = §5.1 三次失敗先 EXTRACT_FAILED） */
export const LABDOC_DEFAULT_MAX_ATTEMPTS = 3

export type LabDocMode = 'TEXT' | 'VISION'
export type LabDocKind = 'INVOICE' | 'STATEMENT'

export interface LabDocExtractRequest {
  mode: LabDocMode
  kindHint: LabDocKind
  /** LabProfile.extractionHint（已識別 Lab 時）；第一次讀未知 Lab = null */
  labHint: string | null
  /** TEXT：逐頁文字，頁之間 '\n<<<PAGE n>>>\n'（≤ 60,000 字 — W 側 cap） */
  text: string | null
  /** VISION：顯示圖 base64 jpeg（長邊 1600，≤ 8 張 — W 側 cap） */
  images: string[] | null
}

/** W 側 sealed 回應內容（result 已成功過 zod 契約；CWM 側仍然會再 parse 一次做 defence-in-depth） */
export interface LabDocExtractOutcome {
  result: LabDocResult | null
  reason: string | null
}

/** null 原因（runner 記入 extractError） */
export type LabDocNullReason =
  | 'not_configured'
  | 'stub_throw'
  | 'busy_exhausted' // 429 重試盡
  | 'rejected' // 4xx（BAD_TAG/STALE/BAD_PAYLOAD/REPLAY…）— 設定／契约錯誤，唔重試
  | 'upstream' // 5xx / NOT_ENABLED
  | 'timeout' // 95s 總時限
  | 'network' // fetch throw（DNS/ECONNREFUSED…）
  | 'llm' // 200 但 result == null（W 側 reason：breaker_open/llm_error/parse_error/bad_response/truncated）

type ExtractFn = (
  req: LabDocExtractRequest,
) => Promise<{ outcome: LabDocExtractOutcome | null; nullReason: LabDocNullReason | null }>

const stats: Record<string, number> = { calls: 0, ok: 0, attempts: 0 }
let warnedNotConfigured = false
let testFn: ExtractFn | null = null

/**
 * 測試 stub：直接注入「transport 層結果」（wrapper 口徑 — 可以模擬 nullReason：timeout／not_configured／…）。
 * 返 { outcome, nullReason }：outcome.result != null = 成功（含 reason='mock'）。
 */

export function __setLabDocExtractFn(fn: ExtractFn | null): void {
  testFn = fn
}
export function labdocLlmStats(): Record<string, number> {
  return { ...stats }
}
export function resetLabdocLlmStats(): void {
  for (const k of Object.keys(stats)) stats[k] = 0
}

function noteNull(reason: LabDocNullReason, meta: Record<string, unknown> = {}): null {
  stats[reason] = (stats[reason] ?? 0) + 1
  // 🔴 metadata only — 唔 log 單據內容（鐵律）
  console.warn(`[labdoc-llm] null reason=${reason} ${JSON.stringify(meta)}`)
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 打 W proxy（§5.2）。回 outcome（result 可能 null）或 null（transport/設定層失敗，附 reason 入 stats）。
 *
 * opts.maxAttempts：429 BUSY 重試上限（預設 3）。其他失敗（4xx/5xx/timeout/network/result==null）
 * 唔喺呢度重試 — runner（§5.1）自己計 attempts + 30 秒 backoff。
 */
export async function extractLabDocViaWaInbox(
  req: LabDocExtractRequest,
  opts?: { maxAttempts?: number },
): Promise<{ outcome: LabDocExtractOutcome | null; nullReason: LabDocNullReason | null }> {
  stats.calls++
  if (testFn) {
    try {
      const r = await testFn(req)
      if (r.outcome?.result !== null && r.outcome !== null) stats.ok++
      return r
    } catch {
      return { outcome: null, nullReason: 'stub_throw' }
    }
  }
  const url = process.env.WA_INBOX_LABDOC_URL
  const secret = process.env.INTERNAL_LLM_SECRET
  const kid = process.env.INTERNAL_LLM_KID || 'k1'
  if (!url || !secret) {
    stats.not_configured = (stats.not_configured ?? 0) + 1
    if (!warnedNotConfigured) {
      warnedNotConfigured = true
      console.warn('[labdoc-llm] null reason=not_configured（WA_INBOX_LABDOC_URL／INTERNAL_LLM_SECRET 未設）')
    }
    return { outcome: null, nullReason: 'not_configured' }
  }

  const maxAttempts = Math.max(1, Math.floor(opts?.maxAttempts ?? LABDOC_DEFAULT_MAX_ATTEMPTS))
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = Date.now()
    try {
      // ★ 每次 attempt 都重新 seal（新 ts + 新 nonce）— 429 重試 = 新 envelope（工單 §1 決定 4）。
      //   seal() 喺 try 入面：key 長度／base64 唔啱會 throw（跟 clinical S5-2 先例）。
      const env = seal(secret, kid, req, REQ_CONTEXT_LABDOC)
      stats.attempts = (stats.attempts ?? 0) + 1
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(env),
        signal: AbortSignal.timeout(LABDOC_CLIENT_TIMEOUT_MS),
      })
      if (res.status === 429) {
        const j = (await res.json().catch(() => ({}))) as { retryAfterSec?: number }
        if (attempt < maxAttempts) {
          await sleep(Math.min(BUSY_SLEEP_CAP_MS, (j.retryAfterSec ?? 5) * 1000))
          continue // 下一圈重新 seal
        }
        return { outcome: null, nullReason: 'busy_exhausted' }
      }
      if (res.status === 409) return { outcome: null, nullReason: 'rejected' } // REPLAY（新 nonce 下理論唔會發生）
      if (res.status === 401 || res.status === 400) return { outcome: null, nullReason: 'rejected' } // BAD_TAG/STALE/BAD_PAYLOAD — 設定/契約錯，重試無意義
      if (res.status === 503 || res.status >= 500) return { outcome: null, nullReason: 'upstream' } // NOT_ENABLED / 5xx
      if (!res.ok) return { outcome: null, nullReason: 'rejected' }
      const out = open<{ result: LabDocResult | null; reason: string | null }>(
        secret,
        (await res.json()) as Envelope,
        respContext(env.nonce),
      )
      // result != null = 成功（含 mock）
      if (out.result === null) {
        return { outcome: { result: null, reason: out.reason ?? 'llm_error' }, nullReason: 'llm' }
      }
      stats.ok++
      return { outcome: { result: out.result, reason: out.reason }, nullReason: null }
    } catch (e) {
      const name = (e as Error)?.name
      const msg = String((e as Error)?.message ?? '')
      if (/INTERNAL_LLM_SECRET/.test(msg)) return { outcome: null, nullReason: 'rejected' } // bad_config（唔夠 32 bytes/唔係 base64）
      if (name === 'TimeoutError' || name === 'AbortError') return { outcome: null, nullReason: 'timeout' }
      if (name === 'SyntaxError' || /auth/i.test(msg)) return { outcome: null, nullReason: 'rejected' } // 信封/回應解析失敗
      return { outcome: null, nullReason: 'network' }
    }
  }
  return { outcome: null, nullReason: 'busy_exhausted' }
}
