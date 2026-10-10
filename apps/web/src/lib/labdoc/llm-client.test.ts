/**
 * cwm-labdoc P2 — llm-client 契約測試（§5.2）。
 * 真 local HTTP server 做 W stub（同一份 llm-envelope seal/open — 實作漂移 → 401 BAD_TAG 立即紅）。
 *
 * 覆蓋：
 *  - REQ_CONTEXT 錨定 'labdoc-extract.v1'（同 W route）
 *  - 200 + result → 成功（result != null 口徑；mock reason='mock' 亦成功）
 *  - 200 + result=null（breaker_open/llm_error/parse_error/bad_response/truncated）→ nullReason='llm'
 *  - 429 BUSY：重試且 **re-seal 新 envelope**（nonce/ts 每次 attempt 都新 — 工單 §1 決定 4）
 *  - 429 耗盡 → busy_exhausted；401/400 → rejected（唔重試）；503/500 → upstream
 *  - env 未設 → not_configured
 *  - timeout：fetch reject TimeoutError → 'timeout'（真 95s 唔實測；常量錨定 95_000）
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { seal, open, respContext, type Envelope } from '../clinical/llm-envelope'

const SECRET = 'labdoc-p2-test-secret-000000000000000000000001' // 32+ bytes base64-able（seal 要 base64 raw ≥ 32B）
const MOCK_RESULT: any = {
  kind: 'INVOICE',
  lab: { nameRaw: 'TESTLAB', nameCnRaw: null, payeeRaw: null },
  billTo: { nameRaw: 'TEST DENTAL', addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
  docNoRaw: 'INV-001', docNoLabel: null, dateRaw: '10 Sep 2026', date: '2026-09-10',
  deliveryDate: null, orderReceivedDate: null, statementMonth: null,
  groups: [{ patientNameRaw: null, patientCodeRaw: null, labCaseRef: null, lines: [{ description: 'Crown', toothRaw: null, qty: null, unitPrice: null, listPrice: null, discountRaw: null, amount: 100 }] }],
  sections: [], subtotal: 100, total: 100, readIssues: [],
}

type MockMode = 'ok' | 'mock' | 'null-result' | 'busy-then-ok' | 'busy-always' | '503' | '401' | '400' | '500'
let mode: MockMode = 'ok'
let reqCount = 0
let seenNonces: string[] = []
let seenTs: number[] = []
let server: http.Server
let baseUrl = ''
let savedEnv: Record<string, string | undefined> = {}
let M: any

before(async () => {
  const lc = await import('./llm-client')
  M = lc
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      reqCount++
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(obj))
      }
      try {
        const env = JSON.parse(body) as Envelope
        if (env?.v !== 1 || env.kid !== 'k1' || typeof env.nonce !== 'string' || env.nonce.length > 64) return send(401, { error: 'BAD_ENVELOPE' })
        if (!Number.isFinite(env.ts) || Math.abs(Date.now() - env.ts) > 60_000) return send(401, { error: 'STALE' })
        const payload = open<any>(SECRET, env, 'labdoc-extract.v1') // 漂移 → throw → 401
        seenNonces.push(env.nonce)
        seenTs.push(env.ts)
        if (mode === 'busy-always') return send(429, { error: 'BUSY', retryAfterSec: 0 })
        if (mode === 'busy-then-ok' && reqCount <= 2) return send(429, { error: 'BUSY', retryAfterSec: 0 })
        if (mode === '503') return send(503, { error: 'NOT_ENABLED' })
        if (mode === '401') return send(401, { error: 'BAD_TAG' })
        if (mode === '400') return send(400, { error: 'BAD_PAYLOAD' })
        if (mode === '500') return send(500, { error: 'upstream' })
        if (mode === 'null-result') {
          return send(200, seal(SECRET, 'k1', { result: null, reason: 'breaker_open' }, respContext(env.nonce)))
        }
        const reason = mode === 'mock' ? 'mock' : null
        return send(200, seal(SECRET, 'k1', { result: MOCK_RESULT, reason }, respContext(env.nonce)))
      } catch {
        return send(401, { error: 'BAD_TAG' })
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/labdoc-extract`
  savedEnv = {
    url: process.env.WA_INBOX_LABDOC_URL,
    secret: process.env.INTERNAL_LLM_SECRET,
    kid: process.env.INTERNAL_LLM_KID,
  }
  process.env.WA_INBOX_LABDOC_URL = baseUrl
  process.env.INTERNAL_LLM_SECRET = SECRET
  process.env.INTERNAL_LLM_KID = 'k1'
})

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k as keyof typeof process.env]
    else process.env[k as keyof typeof process.env] = v
  }
  await new Promise<void>((r) => server.close(() => r()))
  M.__setLabDocExtractFn(null)
})

const reset = () => {
  reqCount = 0
  mode = 'ok'
  seenNonces = []
  seenTs = []
  M.resetLabdocLlmStats()
}

const REQ = { mode: 'TEXT' as const, kindHint: 'INVOICE' as const, labHint: null, text: 'hello', images: null }

test('context 錨定 + 200 ok → result（client 95s 常量）', async () => {
  reset()
  assert.equal(M.REQ_CONTEXT_LABDOC, 'labdoc-extract.v1')
  assert.equal(M.LABDOC_CLIENT_TIMEOUT_MS, 95_000)
  const r = await M.extractLabDocViaWaInbox(REQ)
  assert.equal(r.nullReason, null)
  assert.equal(r.outcome?.result?.docNoRaw, 'INV-001')
  assert.equal(r.outcome?.reason, null)
  assert.equal(reqCount, 1)
  assert.equal(M.labdocLlmStats().ok, 1)
})

test('200 + result + reason=mock → 照計成功（§5.2）', async () => {
  reset()
  mode = 'mock'
  const r = await M.extractLabDocViaWaInbox(REQ)
  assert.equal(r.nullReason, null)
  assert.equal(r.outcome?.reason, 'mock')
  assert.ok(r.outcome?.result)
})

test('200 + result=null（breaker_open）→ nullReason=llm + reason 保留', async () => {
  reset()
  mode = 'null-result'
  const r = await M.extractLabDocViaWaInbox(REQ)
  assert.deepEqual(r.outcome, { result: null, reason: 'breaker_open' })
  assert.equal(r.nullReason, 'llm')
})

test('429 重試 → re-seal 新 envelope（nonce 每次 attempt 都新）', async () => {
  reset()
  mode = 'busy-then-ok'
  const r = await M.extractLabDocViaWaInbox(REQ, { maxAttempts: 3 })
  assert.equal(r.nullReason, null)
  assert.ok(r.outcome?.result)
  assert.equal(reqCount, 3) // 429 + 429 + 200
  assert.equal(seenNonces.length, 3)
  assert.equal(new Set(seenNonces).size, 3, '每次 attempt 必須新 nonce（re-seal）')
  // ts 都係最近 60 秒內
  for (const ts of seenTs) assert.ok(Math.abs(Date.now() - ts) < 60_000)
})

test('429 耗盡 → busy_exhausted', async () => {
  reset()
  mode = 'busy-always'
  const r = await M.extractLabDocViaWaInbox(REQ, { maxAttempts: 2 })
  assert.equal(r.outcome, null)
  assert.equal(r.nullReason, 'busy_exhausted')
  assert.equal(reqCount, 2)
})

test('503 NOT_ENABLED → upstream（唔重試）', async () => {
  reset()
  mode = '503'
  const r = await M.extractLabDocViaWaInbox(REQ)
  assert.equal(r.outcome, null)
  assert.equal(r.nullReason, 'upstream')
  assert.equal(reqCount, 1)
})

test('401 BAD_TAG → rejected（唔重試 — 設定錯）', async () => {
  reset()
  mode = '401'
  const r = await M.extractLabDocViaWaInbox(REQ)
  assert.equal(r.nullReason, 'rejected')
  assert.equal(reqCount, 1)
})

test('400 BAD_PAYLOAD → rejected', async () => {
  reset()
  mode = '400'
  const r = await M.extractLabDocViaWaInbox(REQ)
  assert.equal(r.nullReason, 'rejected')
  assert.equal(reqCount, 1)
})

test('500 → upstream', async () => {
  reset()
  mode = '500'
  const r = await M.extractLabDocViaWaInbox(REQ)
  assert.equal(r.nullReason, 'upstream')
  assert.equal(reqCount, 1)
})

test('env 未設 → not_configured', async () => {
  reset()
  delete process.env.WA_INBOX_LABDOC_URL
  const r = await M.extractLabDocViaWaInbox(REQ)
  assert.equal(r.outcome, null)
  assert.equal(r.nullReason, 'not_configured')
  process.env.WA_INBOX_LABDOC_URL = baseUrl
})

test('timeout：fetch reject TimeoutError → nullReason=timeout（fetch stub）', async () => {
  reset()
  const realFetch = globalThis.fetch
  const timeoutErr = new Error('The operation was aborted due to timeout')
  timeoutErr.name = 'TimeoutError'
  ;(globalThis as any).fetch = async () => {
    throw timeoutErr
  }
  try {
    const r = await M.extractLabDocViaWaInbox(REQ)
    assert.equal(r.outcome, null)
    assert.equal(r.nullReason, 'timeout')
  } finally {
    ;(globalThis as any).fetch = realFetch
  }
})

test('network：fetch reject ECONNREFUSED → nullReason=network', async () => {
  reset()
  const realFetch = globalThis.fetch
  const netErr = new Error('connect ECONNREFUSED 127.0.0.1:1')
  netErr.name = 'Error'
  ;(globalThis as any).fetch = async () => {
    throw netErr
  }
  try {
    const r = await M.extractLabDocViaWaInbox(REQ)
    assert.equal(r.nullReason, 'network')
  } finally {
    ;(globalThis as any).fetch = realFetch
  }
})

test('client 傳 signal（AbortSignal.timeout 95s）— fetch stub 驗 signal 存在', async () => {
  reset()
  const realFetch = globalThis.fetch
  const holder: { signal: AbortSignal | null } = { signal: null }
  ;(globalThis as any).fetch = async (_url: any, init: any) => {
    holder.signal = init?.signal ?? null
    const env = JSON.parse(init.body) as Envelope
    return new Response(JSON.stringify(seal(SECRET, 'k1', { result: MOCK_RESULT, reason: null }, respContext(env.nonce))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const r = await M.extractLabDocViaWaInbox(REQ)
    assert.ok(r.outcome?.result)
    assert.ok(holder.signal instanceof AbortSignal, 'fetch 必須帶 signal（總時限 95s）')
    assert.ok(!holder.signal.aborted, '95s 未過唔應該 abort')
  } finally {
    ;(globalThis as any).fetch = realFetch
  }
})

test('stub fn（__setLabDocExtractFn）優於真 fetch；throw → stub_throw', async () => {
  reset()
  M.__setLabDocExtractFn(async () => ({ outcome: { result: MOCK_RESULT, reason: null }, nullReason: null }))
  const r = await M.extractLabDocViaWaInbox(REQ)
  assert.equal(reqCount, 0) // 冇打 server
  assert.equal(r.outcome?.result?.docNoRaw, 'INV-001')
  M.__setLabDocExtractFn(async () => {
    throw new Error('boom')
  })
  const r2 = await M.extractLabDocViaWaInbox(REQ)
  assert.equal(r2.nullReason, 'stub_throw')
  M.__setLabDocExtractFn(null)
})
