// ============================================================
// llm-client — 最小 OpenAI-compatible client（cwi-followup-p4-20260916 S3）
//
// 第二層報價抽取專用（本地 Qwen / sglang；生產可指任何 OpenAI-compatible）。
// env：
//   LLM_BASE_URL       dev 預設 http://127.0.0.1:30000/v1
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

const DEFAULT_BASE = 'http://127.0.0.1:30000/v1'
const DEFAULT_MODEL = '/models/Qwen3.8-27B-FP8'
const TIMEOUT_MS = 30_000

let testFn: LlmFn | null = null

/** e2e / unit 注入（null = 還原真 client） */
export function __setLlmFn(fn: LlmFn | null): void {
  testFn = fn
}

/** sglang Qwen3：enable_thinking=false 先有 content（thinking 吃光 token budget — 實測）。
 *  只對 local（127.0.0.1/localhost）base 發 — 生產 OpenAI-compatible 唔一定識呢個欄位。 */
function isLocalBase(base: string): boolean {
  return /(^|:)\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base)
}

export async function llmChat(msgs: LlmChatMsg[], opts?: { maxTokens?: number }): Promise<LlmResult | null> {
  if (testFn) {
    try {
      return await testFn(msgs, opts)
    } catch {
      return null
    }
  }
  const base = (process.env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
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
    if (!res.ok) return null
    const j = (await res.json()) as any
    const content = j?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) return null
    return { content: content.trim(), model: typeof j?.model === 'string' ? j.model : model }
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}
