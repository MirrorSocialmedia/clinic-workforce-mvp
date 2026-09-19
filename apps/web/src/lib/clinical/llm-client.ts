// ============================================================
// llm-client — 最小 OpenAI-compatible client（cwi-followup-p4-20260916 S3）
//
// 第二層報價抽取專用（本地 Qwen / sglang；生產可指任何 OpenAI-compatible）。
// env：
//   LLM_BASE_URL       必填（未設 = 短路回 null + log reason=not_configured；S2-9 上線前唔打 container 自己）
//   LLM_API_KEY        dev 空（sglang 無 key）
//   LLM_MODEL          dev 預設 /models/Qwen3.8-27B-FP8
//   LLM_ENABLE_THINKING 預設 false（Qwen3 thinking model：唔關 = 輸出全食 reasoning，
//                     content 空 — 2026-09-16 實測）
//
// 口徑：任何失敗（timeout / 非 200 / content 空 / parse 錯）= 回 null
//   （caller 當「低信心」落確認隊列 — 唔 throw、唔阻 pipeline）。
// e2e 決定性（鐵律 8）：__setLlmFn 注入 stub，唔打真 LLM。
// ============================================================

export interface LlmChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmResult {
  content: string
  model: string
}

export type LlmFn = (msgs: LlmChatMsg[], opts?: { maxTokens?: number }) => Promise<LlmResult | null>

const DEFAULT_MODEL = '/models/Qwen3.8-27B-FP8'
const TIMEOUT_MS = 30_000

// ★ cwi-final S0-9：零產出分支一律 log 原因碼（metadata only — 唔准 log msgs／content）
export type LlmNullReason = 'not_configured' | 'stub_throw' | 'http' | 'empty' | 'timeout' | 'network'
const stats: Record<string, number> = { calls: 0, ok: 0 }
let warnedNotConfigured = false

function noteNull(reason: LlmNullReason, meta: Record<string, unknown> = {}): null {
  stats[reason] = (stats[reason] ?? 0) + 1
  console.warn(`[clinical-llm] null reason=${reason} ${JSON.stringify(meta)}`)
  return null
}
/** job 完結時印（nightly／refresh／backfill）— 睇到「LLM 層零產出」 */
export function llmStats(): Record<string, number> { return { ...stats } }
export function resetLlmStats(): void { for (const k of Object.keys(stats)) stats[k] = 0; stats.calls = 0; stats.ok = 0 }

let testFn: LlmFn | null = null

/** e2e / unit 注入（null = 還原真 client） */
export function __setLlmFn(fn: LlmFn | null): void {
  testFn = fn
}

/** sglang Qwen3：enable_thinking=false 先有 content（thinking 吃光 token budget — 實測）。
 *  只對「自家機器」base 發（loopback / RFC1918 內網 / host.docker.internal）—
 *  生產 OpenAI-compatible 唔一定識呢個欄位。2026-09-16：生產 sglang 喺 LAN IP（192.168.x），
 *  舊版 regex 只認 127.0.0.1 → 生產唔發 flag → thinking 食光 token → LLM 層靜默死（CEO 實測捉到）。 */
function isLocalBase(base: string): boolean {
  return /(^|:)\/\/(127\.0\.0\.1|localhost|host\.docker\.internal|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:|\/|$)/.test(base)
}

export async function llmChat(msgs: LlmChatMsg[], opts?: { maxTokens?: number }): Promise<LlmResult | null> {
  stats.calls++
  if (testFn) {
    try { const r = await testFn(msgs, opts); if (r) stats.ok++; return r }
    catch { return noteNull('stub_throw') }
  }
  // S2-9 上線前：未設定 = 短路（唔再打 container 自己嘅 127.0.0.1）
  if (!process.env.LLM_BASE_URL) {
    stats.not_configured = (stats.not_configured ?? 0) + 1
    if (!warnedNotConfigured) {
      warnedNotConfigured = true
      console.warn('[clinical-llm] null reason=not_configured（LLM_BASE_URL 未設 — 報價第二層停用，低信心行落確認隊列；S2-9 之後改經 wa-inbox proxy）')
    }
    return null
  }
  const base = process.env.LLM_BASE_URL.replace(/\/+$/, '')
  const model = process.env.LLM_MODEL || DEFAULT_MODEL
  const key = (process.env.LLM_API_KEY || '').trim()
  const thinking = (process.env.LLM_ENABLE_THINKING ?? 'false').toLowerCase() === 'true'

  const body: Record<string, unknown> = {
    model,
    messages: msgs,
    max_tokens: opts?.maxTokens ?? 800,
  }
  if (isLocalBase(base)) {
    body.chat_template_kwargs = { enable_thinking: thinking }
  }

  const ctrl = new AbortController()
  const t0 = Date.now()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) return noteNull('http', { status: res.status, ms: Date.now() - t0 })
    const j = (await res.json()) as any
    const content = j?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim())
      return noteNull('empty', { finish: j?.choices?.[0]?.finish_reason ?? null, hasReasoning: typeof j?.choices?.[0]?.message?.reasoning_content === 'string' })
    stats.ok++
    return { content: content.trim(), model: typeof j?.model === 'string' ? j.model : model }
  } catch (e) {
    return noteNull((e as Error)?.name === 'AbortError' ? 'timeout' : 'network', { ms: Date.now() - t0 })
  } finally {
    clearTimeout(t)
  }
}
