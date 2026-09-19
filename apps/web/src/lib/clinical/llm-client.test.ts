/**
 * llm-client — cwi-final S0-9（T752）
 *
 * 覆蓋：
 *   - 冇 LLM_BASE_URL → 回 null、stats.not_configured 計數、console.warn 只出一次（call 兩次）
 *   - stub fetch 回 500 → warn 含 reason=http + "status":500
 *   - 紅線 D-2：warn 只出 metadata — 唔包含 user message 內容（marker 斷言）
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { llmChat, llmStats, resetLlmStats, __setLlmFn } from './llm-client'

const MARKER = 'USERMSG-PII-MARKER-4f7c2a' // user message 內容 marker — warn 絕對唔准包含

describe('llm-client cwi-final S0-9（T752）', () => {
  let savedBase: string | undefined
  let warns: string[]
  let origWarn: typeof console.warn
  let origFetch: typeof fetch

  before(() => {
    savedBase = process.env.LLM_BASE_URL
    origWarn = console.warn
    warns = []
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')) }
    origFetch = globalThis.fetch
  })
  after(() => {
    console.warn = origWarn
    globalThis.fetch = origFetch
    if (savedBase === undefined) delete process.env.LLM_BASE_URL
    else process.env.LLM_BASE_URL = savedBase
    __setLlmFn(null)
  })

  it('冇 LLM_BASE_URL → null + stats.not_configured 計數 + warn 只出一次（call 兩次）', async () => {
    delete process.env.LLM_BASE_URL
    resetLlmStats()
    warns.length = 0

    const r1 = await llmChat([{ role: 'user', content: MARKER }])
    assert.equal(r1, null)
    assert.equal(llmStats().not_configured, 1)

    const r2 = await llmChat([{ role: 'user', content: MARKER }])
    assert.equal(r2, null)
    assert.equal(llmStats().not_configured, 2)

    // warn 一 process 只出一次（两次 call）
    const ncWarns = warns.filter((w) => w.includes('reason=not_configured'))
    assert.equal(ncWarns.length, 1)
    assert.ok(!ncWarns[0].includes(MARKER), 'warn 唔准含 user message 內容')
  })

  it('stub fetch 500 → warn 含 reason=http + "status":500（零 PII）', async () => {
    process.env.LLM_BASE_URL = 'http://127.0.0.1:39999/v1'
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
    resetLlmStats()
    warns.length = 0

    const r = await llmChat([{ role: 'user', content: MARKER }])
    assert.equal(r, null)
    assert.equal(llmStats().http, 1)

    const w = warns.filter((x) => x.includes('reason=http'))
    assert.equal(w.length, 1)
    assert.ok(w[0].includes('"status":500'), `warn 應該有 "status":500 — 實際: ${w[0]}`)
    assert.ok(!w[0].includes(MARKER), 'warn 唔准含 user message 內容（紅線 D-2）')
  })
})
