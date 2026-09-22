// ★ cwi-final S2-9（D-2）：報價第二層改經 wa-inbox proxy。LLM_* env 不再使用。
import { seal, open, REQ_CONTEXT, respContext, type Envelope } from './llm-envelope'
import type { TermEntry } from './quote-parser'

export interface ProxyItem { text: string | null; code: string | null; amount: number | null; perUnit: boolean }
export type ExtractFn = (notePlain: string, terms: TermEntry[]) => Promise<ProxyItem[] | null>

type NullReason = 'not_configured' | 'stub_throw' | 'busy' | 'rejected' | 'upstream' | 'timeout' | 'network' | 'bad_response' | 'llm'
const stats: Record<string, number> = { calls: 0, ok: 0 }
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

export async function extractViaWaInbox(notePlain: string, terms: TermEntry[]): Promise<ProxyItem[] | null> {
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
  for (let attempt = 1; attempt <= 3; attempt++) {
    const env = seal(secret, kid, body, REQ_CONTEXT)
    const t0 = Date.now()
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env), signal: AbortSignal.timeout(35_000) })
      if (res.status === 429) {
        const j = (await res.json().catch(() => ({}))) as { retryAfterSec?: number }
        if (attempt < 3) { await sleep(Math.min(10, j.retryAfterSec ?? 5) * 1000); continue }
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
      if (name === 'TimeoutError' || name === 'AbortError') return noteNull('timeout', { ms: Date.now() - t0 })
      if (name === 'SyntaxError' || /auth/i.test(String((e as Error)?.message))) return noteNull('bad_response')
      return noteNull('network', { ms: Date.now() - t0 })
    }
  }
  return null
}
