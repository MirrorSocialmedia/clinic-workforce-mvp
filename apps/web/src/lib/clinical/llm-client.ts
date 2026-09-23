// ★ cwi-final S2-9（D-2）：報價第二層改經 wa-inbox proxy。LLM_* env 不再使用。
import { seal, open, REQ_CONTEXT, respContext, type Envelope } from './llm-envelope'
import type { TermEntry } from './quote-parser'

export interface ProxyItem { text: string | null; code: string | null; amount: number | null; perUnit: boolean }
export type ExtractFn = (notePlain: string, terms: TermEntry[]) => Promise<ProxyItem[] | null>

type NullReason = 'not_configured' | 'stub_throw' | 'busy' | 'rejected' | 'upstream' | 'timeout' | 'network' | 'bad_response' | 'bad_config' | 'llm'
// ★ cwm-leaveasoffix-20260923 S5-1：`attempts` = 真正會打去 proxy 嘅次數（唔包 not_configured／stub）。
//   backfill 嘅 GAP／budget 一定要用佢 —— 用 `calls` 會連「未設定、乜都冇做」都當打咗。
const stats: Record<string, number> = { calls: 0, ok: 0, attempts: 0 }
let warnedNotConfigured = false
let testFn: ExtractFn | null = null
export function __setExtractFn(fn: ExtractFn | null): void { testFn = fn }
export function llmStats() { return { ...stats } }
export function resetLlmStats() { for (const k of Object.keys(stats)) stats[k] = 0 }

function noteNull(reason: NullReason, meta: Record<string, unknown> = {}): null {
  stats[reason] = (stats[reason] ?? 0) + 1
  console.warn(`[clinical-llm] null reason=${reason} ${JSON.stringify(meta)}`)
  return null
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function extractViaWaInbox(
  notePlain: string,
  terms: TermEntry[],
  /** ★ S5-3：request path（手動刷新）傳 1 —— 429 重試只留畀 nightly／backfill，唔好令外部 API 卡 55 秒 */
  opts?: { maxAttempts?: number },
): Promise<ProxyItem[] | null> {
  stats.calls++
  if (testFn) {
    try { const r = await testFn(notePlain, terms); if (r) stats.ok++; return r } catch { return noteNull('stub_throw') }
  }
  const url = process.env.WA_INBOX_LLM_URL
  const secret = process.env.INTERNAL_LLM_SECRET
  const kid = process.env.INTERNAL_LLM_KID || 'k1'
  if (!url || !secret) {
    stats.not_configured = (stats.not_configured ?? 0) + 1
    if (!warnedNotConfigured) { warnedNotConfigured = true; console.warn('[clinical-llm] null reason=not_configured（WA_INBOX_LLM_URL／INTERNAL_LLM_SECRET 未設）') }
    return null
  }
  const body = { notePlain: notePlain.slice(0, 2000), terms: terms.map((t) => ({ shorthand: t.shorthand, nameCn: t.nameCn, nameEn: t.nameEn ?? null })) }
  stats.attempts = (stats.attempts ?? 0) + 1
  const maxAttempts = Math.max(1, Math.floor(opts?.maxAttempts ?? 3))
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = Date.now()
    try {
      // ★ S5-2：seal() 一定要喺 try 入面 —— key 長度／base64 唔啱會 throw，
      //   舊版擺喺 try 外面 → throw 一路拋到 storeQuotesForVisit 外面，
      //   caller 雖然有 try/catch（唔會 500），但 catch 位喺「寫入之前」→
      //   連第一層 parser 抽到嘅高信心報價都唔會入庫。口徑係「任何失敗回 null」。
      const env = seal(secret, kid, body, REQ_CONTEXT)
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env), signal: AbortSignal.timeout(35_000) })
      if (res.status === 429) {
        const j = (await res.json().catch(() => ({}))) as { retryAfterSec?: number }
        if (attempt < maxAttempts) { await sleep(Math.min(10, j.retryAfterSec ?? 5) * 1000); continue }
        return noteNull('busy', { attempt })
      }
      if (res.status === 503 || res.status >= 500) return noteNull('upstream', { status: res.status, ms: Date.now() - t0 })
      if (!res.ok) return noteNull('rejected', { status: res.status })
      const out = open<{ items: ProxyItem[] | null; reason: string | null }>(secret, (await res.json()) as Envelope, respContext(env.nonce))
      if (!out.items) return noteNull('llm', { reason: out.reason, ms: Date.now() - t0 })
      stats.ok++
      return out.items
    } catch (e) {
      const name = (e as Error)?.name
      const msg = String((e as Error)?.message ?? '')
      // ★ S5-2：key 設錯（唔夠 32 bytes／唔係 base64）—— 唔好當 network，要一眼睇得出係設定問題
      if (/INTERNAL_LLM_SECRET/.test(msg)) return noteNull('bad_config', { ms: Date.now() - t0 })
      if (name === 'TimeoutError' || name === 'AbortError') return noteNull('timeout', { ms: Date.now() - t0 })
      if (name === 'SyntaxError' || /auth/i.test(msg)) return noteNull('bad_response')
      return noteNull('network', { ms: Date.now() - t0 })
    }
  }
  return null
}
