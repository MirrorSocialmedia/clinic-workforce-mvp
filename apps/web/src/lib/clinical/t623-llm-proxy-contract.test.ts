// ============================================================
// T623（workforce 側）— cwi-final S2-9b LLM proxy contract test
//
// stub wa-inbox（127.0.0.1 ephemeral-port mock，**零 GPU**）：
//   1. storeQuotesForVisit 出高信心行（orphan → proxy 落字典 code → high）
//      + 雙保險抽驗（proxy 回傳非字典 code → 本地字典再驗 → 丟）
//   2. reason 分類抽驗：not_configured / busy 429 重試（成功＋耗盡）/
//      upstream 500 / rejected 400 / timeout（fetch stub — 真 timeout 35s 唔實測）
//
// mock 用同一份 llm-envelope 實作 open 請求信封 — 兩邊實作漂移 → 401 → 紅。
//
// DB：dev 15532（CWM_TEST_DATABASE_URL 可覆蓋）— 只寫 QuotedItem（固定 visitId，
// 冪等）+ ClinicalTermMap T623 前綴行；after() 必跑 cleanup + 零殘留 assert。
// ⚠️ 本 repo tsx 跑 CJS — 唔准 top-level await；prisma module 必須喺
//   DATABASE_URL 設定之後先動態 import（.env auto-load 陷阱 — 見
//   payroll-snapshot-asof-write.test.ts 註解）。所有 import 都入 before()。
// ============================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Envelope } from './llm-envelope' // type-only（runtime 唔評估）

const SECRET = 'Y3dpLXMyOWEtdGVzdC1rZXktMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMQ==' // fixture 固定測試 key（非生產）
const TERM_IDS = ['T623A', 'T623B']
const VISIT_ID = 'e2et623visit20260923x1' // 固定 → 重跑冪等（pending 重建）
// orphan 段：金額 900@ 無術語 → low → needsLlm；「洗」已核實唔喺 ClinicalTermMap（2026-09-23）
const NOTE = { kind: 'STANDARD', complaints: '', findings: 'quoted 900@ 洗', diagnosis: '', actions: '' } as const
const NOTE_PLAIN = 'quoted 900@ 洗'
const TERMS_MIN = [
  { shorthand: 'T623A', nameCn: 'T623測試項目A', nameEn: null, active: true },
  { shorthand: 'T623B', nameCn: 'T623測試項目B', nameEn: null, active: true },
]
// proxy 回傳：T623A 落字典（配對 orphan → high）；ZZZ 唔喺字典（雙保險 → 丟）
const MOCK_ITEMS = [
  { text: '洗', code: 'T623A', amount: 900, perUnit: true },
  { text: 'weird term', code: 'ZZZ', amount: 100, perUnit: false },
]

// ── lazy handles（CJS：import 全部喺 before() 內 — 順序受控）─────────────
type Mod = { basePrisma: any; storeQuotesForVisit: any; resetTermCache: any; extractViaWaInbox: any; llmStats: any; resetLlmStats: any; __setExtractFn: any; seal: any; open: any; REQ_CONTEXT: string; respContext: (n: string) => string }
let M: Mod
let server: http.Server
let savedEnv: { url?: string; secret?: string; kid?: string } = {}
// ★ cwm-leaveasoffix-20260923 S6：冇測試 DB 時唔可以令成個 `npm test` 吊死 ——
//   舊版 before() 喺 deleteMany 度 throw，after() 又喺同一句 throw → http server 冇 close、
//   prisma pool 冇 disconnect → node:test 等到 runner timeout，後面 3 個 test 檔完全冇跑。
let dbDown = false

type MockMode = 'ok' | 'busy-then-ok' | 'busy-always' | '500' | '400'
let mode: MockMode = 'ok'
let reqCount = 0

before(async () => {
  // 1) DB env 先定先 import prisma（.env auto-load 陷阱）
  const DB_URL = process.env.CWM_TEST_DATABASE_URL ?? 'postgresql://cw_dev:***@127.0.0.1:15532/clinic_workforce?schema=public'
  process.env.DATABASE_URL = DB_URL
  const [prisma, qe, lc, envm] = await Promise.all([
    import('@/lib/prisma'),
    import('./quote-extract'),
    import('./llm-client'),
    import('./llm-envelope'),
  ])
  M = {
    basePrisma: prisma.basePrisma,
    storeQuotesForVisit: qe.storeQuotesForVisit,
    resetTermCache: qe.resetTermCache,
    extractViaWaInbox: lc.extractViaWaInbox,
    llmStats: lc.llmStats,
    resetLlmStats: lc.resetLlmStats,
    __setExtractFn: lc.__setExtractFn,
    seal: envm.seal,
    open: envm.open,
    REQ_CONTEXT: envm.REQ_CONTEXT,
    respContext: envm.respContext,
  }
  assert.equal(M.REQ_CONTEXT, 'req:llm-extract') // 值錨定（同 W route 口徑）

  // 2) stub wa-inbox（ephemeral port；零 GPU）— mock 用同一份 envelope 實作 open 請求
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
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
        M.open(SECRET, env, M.REQ_CONTEXT) // 實作漂移 → throw → 401（drift detector）
        if (mode === 'busy-always') return send(429, { error: 'BUSY', retryAfterSec: 0 })
        if (mode === 'busy-then-ok' && reqCount <= 2) return send(429, { error: 'BUSY', retryAfterSec: 0 })
        if (mode === '500') return send(500, { error: 'upstream_error' })
        if (mode === '400') return send(400, { error: 'BAD_PAYLOAD' })
        const out = M.seal(SECRET, 'k1', { items: MOCK_ITEMS, reason: null }, M.respContext(env.nonce))
        return send(200, out)
      } catch {
        return send(401, { error: 'BAD_TAG' })
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port

  // 3) client env（存還原值）
  savedEnv = { url: process.env.WA_INBOX_LLM_URL, secret: process.env.INTERNAL_LLM_SECRET, kid: process.env.INTERNAL_LLM_KID }
  process.env.WA_INBOX_LLM_URL = `http://127.0.0.1:${port}/api/internal/llm-extract`
  process.env.INTERNAL_LLM_SECRET = SECRET
  process.env.INTERNAL_LLM_KID = 'k1'

  // 4) 術語表 seed（冪等 pre-clean）+ 清 term cache（5 分鐘 in-process）
  try {
    await M.basePrisma.clinicalTermMap.deleteMany({ where: { shorthand: { in: TERM_IDS } } })
    await M.basePrisma.clinicalTermMap.create({ data: { shorthand: 'T623A', nameCn: 'T623測試項目A', nameEn: null, usedFor: ['quote_extraction'] } })
    await M.basePrisma.clinicalTermMap.create({ data: { shorthand: 'T623B', nameCn: 'T623測試項目B', nameEn: null, usedFor: ['quote_extraction'] } })
  } catch (e) {
    dbDown = true
    console.warn(`[T623] skip —— 連唔到測試 DB（設 CWM_TEST_DATABASE_URL 可覆蓋）：${(e as Error)?.message}`)
    await M.basePrisma.$disconnect().catch(() => {})
  }
  M.resetTermCache()
  M.__setExtractFn(null)
  M.resetLlmStats()
})

after(async () => {
  if (!dbDown) {
    await M.basePrisma.quotedItem.deleteMany({ where: { sourceVisitId: VISIT_ID } })
    await M.basePrisma.clinicalTermMap.deleteMany({ where: { shorthand: { in: TERM_IDS } } })
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k as 'WA_INBOX_LLM_URL' | 'INTERNAL_LLM_SECRET' | 'INTERNAL_LLM_KID']
    else process.env[k as 'WA_INBOX_LLM_URL' | 'INTERNAL_LLM_SECRET' | 'INTERNAL_LLM_KID'] = v
  }
  await new Promise<void>((r) => server.close(() => r()))
  if (dbDown) return
  // 零殘留
  assert.equal(await M.basePrisma.quotedItem.count({ where: { sourceVisitId: VISIT_ID } }), 0)
  assert.equal(await M.basePrisma.clinicalTermMap.count({ where: { shorthand: { in: TERM_IDS } } }), 0)
})

const reset = () => { reqCount = 0; mode = 'ok'; M.resetLlmStats() }

test('T623 main: storeQuotesForVisit → 高信心行（stub proxy 落字典 code + 雙保險丟非字典 code）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB（CWM_TEST_DATABASE_URL 未設）')
  reset()
  const { stored } = await M.storeQuotesForVisit({
    visitId: VISIT_ID,
    clinicId: 'e2et623clinicx1',
    patientApricotId: 'e2et623patientx1',
    visitDate: new Date('2026-09-22T00:00:00Z'),
    note: NOTE,
  })
  assert.equal(stored, 1)
  const rows = await M.basePrisma.quotedItem.findMany({ where: { sourceVisitId: VISIT_ID }, orderBy: { createdAt: 'asc' } })
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.certainty, 'high') // LLM 落返字典 code = 高信心
  assert.equal(r.termShorthand, 'T623A')
  assert.equal(r.amountMin, 900)
  assert.equal(r.amountMax, 900)
  assert.equal(r.perUnit, true)
  assert.equal(r.source, 'llm')
  assert.equal(r.intent, 'not_done') // quoted = 建議未做（鐵律 §6.5）
  assert.equal(r.status, 'pending')
  const s = M.llmStats()
  assert.equal(s.calls, 1)
  assert.equal(s.ok, 1)
  assert.equal(reqCount, 1) // 真 HTTP 打咗 stub（唔係 testFn shortcut）
})

test('T623 reason: not_configured（WA_INBOX_LLM_URL／INTERNAL_LLM_SECRET 未設）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB（CWM_TEST_DATABASE_URL 未設）')
  reset()
  const saved = { url: process.env.WA_INBOX_LLM_URL, secret: process.env.INTERNAL_LLM_SECRET }
  delete process.env.WA_INBOX_LLM_URL
  delete process.env.INTERNAL_LLM_SECRET
  try {
    const r = await M.extractViaWaInbox(NOTE_PLAIN, TERMS_MIN)
    assert.equal(r, null)
    const s = M.llmStats()
    assert.equal(s.calls, 1)
    assert.equal(s.not_configured, 1)
    assert.equal(reqCount, 0) // 短路 — 冇打下游
  } finally {
    process.env.WA_INBOX_LLM_URL = saved.url
    process.env.INTERNAL_LLM_SECRET = saved.secret
  }
})

test('T623 reason: busy 429 重試 → 第 3 次成功（retryAfterSec=0 ×2）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB（CWM_TEST_DATABASE_URL 未設）')
  reset()
  mode = 'busy-then-ok'
  const r = await M.extractViaWaInbox(NOTE_PLAIN, TERMS_MIN)
  assert.ok(r)
  assert.equal(r!.length, 2)
  const s = M.llmStats()
  assert.equal(s.ok, 1)
  assert.equal(reqCount, 3) // 429 + 429 + 200
})

test('T623 reason: busy 429 耗盡（3 次全 429 → busy）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB（CWM_TEST_DATABASE_URL 未設）')
  reset()
  mode = 'busy-always'
  const r = await M.extractViaWaInbox(NOTE_PLAIN, TERMS_MIN)
  assert.equal(r, null)
  const s = M.llmStats()
  assert.equal(s.busy, 1)
  assert.equal(reqCount, 3)
})

test('T623 reason: upstream 500', async (t) => {
  if (dbDown) return t.skip('冇測試 DB（CWM_TEST_DATABASE_URL 未設）')
  reset()
  mode = '500'
  const r = await M.extractViaWaInbox(NOTE_PLAIN, TERMS_MIN)
  assert.equal(r, null)
  assert.equal(M.llmStats().upstream, 1)
  assert.equal(reqCount, 1)
})

test('T623 reason: rejected 400', async (t) => {
  if (dbDown) return t.skip('冇測試 DB（CWM_TEST_DATABASE_URL 未設）')
  reset()
  mode = '400'
  const r = await M.extractViaWaInbox(NOTE_PLAIN, TERMS_MIN)
  assert.equal(r, null)
  assert.equal(M.llmStats().rejected, 1)
  assert.equal(reqCount, 1)
})

test('T623 reason: timeout（fetch stub reject TimeoutError — 真 35s timeout 唔實測）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB（CWM_TEST_DATABASE_URL 未設）')
  reset()
  const origFetch = globalThis.fetch
  const err = new Error('The operation was aborted due to timeout')
  err.name = 'TimeoutError'
  globalThis.fetch = (async () => { throw err }) as unknown as typeof fetch
  try {
    const r = await M.extractViaWaInbox(NOTE_PLAIN, TERMS_MIN)
    assert.equal(r, null)
    assert.equal(M.llmStats().timeout, 1)
    assert.equal(reqCount, 0)
  } finally {
    globalThis.fetch = origFetch
  }
})
