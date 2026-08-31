/**
 * External API v1 守門 unit tests（MD §A.2）— cw-extapi-20260823-a1
 *
 * Fake prisma（monkey-patch basePrisma + prisma 兩個物件 — 同一套 fake）：
 *   - 測試 key 全部係假值（sha256 of 'ext-test-key-...'），唔係真 key。
 *   - 覆蓋：401（缺/錯 key）、403（scope）、429（60 burst）、lastUsedAt、
 *     withExternalAudit（200 / 4xx ExternalApiError / 5xx generic / anonymous audit）。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { prisma, basePrisma } from './prisma'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
  resetExternalRateBuckets,
  takeRefreshToken,
  isValidDateStr,
  dateDiffDays,
} from './external-api'

// ── 測試用假 key（fixture 值 — 唔係真 key）────────────────────────────
const KEY_MAIN = 'ext-test-key-main-0000000000000000000000000000000000000000000000000000'
const KEY_NOSCOPE = 'ext-test-key-noscope-0000000000000000000000000000000000000000000000000000'
const KEY_BURST = 'ext-test-key-burst-0000000000000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const KEY_ROWS = [
  { id: 'k-main', name: 'test-key-main', keyHash: sha(KEY_MAIN), scopes: ['availability', 'duty-roster'], active: true, lastUsedAt: null },
  { id: 'k-noscope', name: 'test-key-noscope', keyHash: sha(KEY_NOSCOPE), scopes: ['duty-roster'], active: true, lastUsedAt: null },
  { id: 'k-burst', name: 'test-key-burst', keyHash: sha(KEY_BURST), scopes: ['availability'], active: true, lastUsedAt: null },
] as const

type Any = any
const keyUpdates: Any[] = []
const auditCreates: Any[] = []

const fakes = {
  externalApiKey: {
    findMany: async () => KEY_ROWS,
    update: async (args: Any) => { keyUpdates.push(args); return {} },
  },
  externalApiAudit: {
    create: async (args: Any) => { auditCreates.push(args.data); return {} },
  },
}

let saved: [Any, string, Any][] = []
before(() => {
  for (const obj of [prisma, basePrisma]) {
    for (const k of Object.keys(fakes) as (keyof typeof fakes)[]) {
      saved.push([obj, k, (obj as Any)[k]])
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
  }
})
after(() => {
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
})
beforeEach(() => {
  keyUpdates.length = 0
  auditCreates.length = 0
  resetExternalRateBuckets()
})

function mkReq(headers: Record<string, string> = {}): any {
  return { headers: new Headers(headers) }
}

// ── requireExternalKey ────────────────────────────────────────────────

describe('requireExternalKey — §A.2 守門', () => {
  it('冇 key → 401 UNAUTHORIZED', async () => {
    await assert.rejects(
      () => requireExternalKey(mkReq(), 'availability'),
      (e: any) => e instanceof ExternalApiError && e.status === 401 && e.code === 'UNAUTHORIZED',
    )
  })

  it('錯 key → 401 UNAUTHORIZED', async () => {
    await assert.rejects(
      () => requireExternalKey(mkReq({ 'x-api-key': 'ext-test-key-wrong-0000000000000000000000000000000000000000000000000' }), 'availability'),
      (e: any) => e instanceof ExternalApiError && e.status === 401,
    )
  })

  it('scope 未授予 → 403 FORBIDDEN', async () => {
    await assert.rejects(
      () => requireExternalKey(mkReq({ 'x-api-key': KEY_NOSCOPE }), 'availability'),
      (e: any) => e instanceof ExternalApiError && e.status === 403 && e.code === 'FORBIDDEN',
    )
  })

  it('過關 → 回傳 key row + fire-and-forget lastUsedAt 更新', async () => {
    const row = await requireExternalKey(mkReq({ 'x-api-key': KEY_MAIN }), 'availability')
    assert.equal(row.name, 'test-key-main')
    // lastUsedAt 係 fire-and-forget — 微任務落完先斷言
    await new Promise(r => setImmediate(r))
    assert.ok(keyUpdates.length >= 1)
    assert.equal(keyUpdates[0].where.id, 'k-main')
    assert.ok(keyUpdates[0].data.lastUsedAt instanceof Date)
  })

  it('狂打 → 前 60 通過、第 61 個 429 RATE_LIMITED（token bucket 60 burst, 1/s）', async () => {
    let ok = 0
    let limited: any = null
    for (let i = 0; i < 61; i++) {
      try {
        await requireExternalKey(mkReq({ 'x-api-key': KEY_BURST }), 'availability')
        ok++
      } catch (e: any) {
        if (e instanceof ExternalApiError && e.status === 429) limited = e
        else throw e
      }
    }
    assert.equal(ok, 60)
    assert.ok(limited, '第 61 個請求應該被 rate limit')
    assert.equal(limited.code, 'RATE_LIMITED')
  })
})

// ── withExternalAudit ─────────────────────────────────────────────────

describe('withExternalAudit — 統一錯誤形狀 + audit 行', () => {
  it('200 路徑：response 原樣返回 + audit 行（keyName/path/status/latencyMs，零 PII）', async () => {
    const res = await withExternalAudit(mkReq(), '/api/external/v1/availability', async (ctx) => {
      ctx.setKey('test-key-main')
      return NextResponse.json({ v: 1 }, { status: 200 })
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { v: 1 })
    assert.equal(auditCreates.length, 1)
    const row = auditCreates[0]
    assert.deepEqual(
      Object.keys(row).sort(),
      ['keyName', 'latencyMs', 'path', 'status'], // 零 PII：只有 metadata 四欄
    )
    assert.equal(row.keyName, 'test-key-main')
    assert.equal(row.path, '/api/external/v1/availability')
    assert.equal(row.status, 200)
    assert.equal(typeof row.latencyMs, 'number')
  })

  it('4xx：ExternalApiError → 原 status + { error, code }', async () => {
    const res = await withExternalAudit(mkReq(), '/api/external/v1/availability', async () => {
      throw new ExternalApiError(404, 'clinic not found', 'CLINIC_NOT_FOUND')
    })
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'clinic not found', code: 'CLINIC_NOT_FOUND' })
    assert.equal(auditCreates[0].status, 404)
    assert.equal(auditCreates[0].keyName, 'anonymous') // 404 喺 auth 後但 demo 冇 setKey → anonymous
  })

  it('5xx：未知錯誤 → generic { error, code: INTERNAL }，內部內容唔洩入 body', async () => {
    const res = await withExternalAudit(mkReq(), '/api/external/v1/availability', async () => {
      throw new Error('db exploded: postgres://secret:pass@prod/internal-query-leak')
    })
    assert.equal(res.status, 500)
    const body = await res.json()
    assert.deepEqual(body, { error: 'internal error', code: 'INTERNAL' })
    const raw = JSON.stringify(body)
    assert.ok(!raw.includes('postgres://'))
    assert.ok(!raw.includes('secret:pass'))
    assert.equal(auditCreates[0].status, 500)
  })
})

// ── 日期工具 ──────────────────────────────────────────────────────────

describe('日期參數工具', () => {
  it('isValidDateStr：格式 + 真實日期', () => {
    assert.ok(isValidDateStr('2026-08-20'))
    assert.ok(isValidDateStr('2024-02-29')) // leap year
    assert.ok(!isValidDateStr('2026-02-30'))
    assert.ok(!isValidDateStr('2023-02-29'))
    assert.ok(!isValidDateStr('2026-13-01'))
    assert.ok(!isValidDateStr('2026-8-20'))
    assert.ok(!isValidDateStr('2026/08/20'))
    assert.ok(!isValidDateStr(''))
  })

  it('dateDiffDays：純日曆差', () => {
    assert.equal(dateDiffDays('2026-08-20', '2026-08-20'), 0)
    assert.equal(dateDiffDays('2026-08-20', '2026-09-20'), 31)
    assert.equal(dateDiffDays('2026-08-20', '2026-09-21'), 32)
    assert.equal(dateDiffDays('2026-08-21', '2026-08-20'), -1)
    assert.equal(dateDiffDays('2026-07-31', '2026-08-01'), 1)
  })
})

// ── takeRefreshToken（cwi-refresh-20260831 §2）────────────────────────────

describe('takeRefreshToken — refresh 限流（每 clinic 每 60 秒 1 次）', () => {
  it('首次 ok；60 秒內第二次拒 + retryAfterSec ≈ 60', () => {
    assert.deepEqual(takeRefreshToken('clinic-a'), { ok: true })
    const second = takeRefreshToken('clinic-a')
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.ok(
        second.retryAfterSec >= 55 && second.retryAfterSec <= 60,
        `retryAfterSec=${second.retryAfterSec} 應該喺 55–60 範圍`,
      )
    }
  })

  it('唔同 clinic 獨立 bucket（防 code/cuid 別名繞過）', () => {
    assert.deepEqual(takeRefreshToken('clinic-a'), { ok: true })
    assert.deepEqual(takeRefreshToken('clinic-b'), { ok: true })
  })

  it('60 秒後 refill 返 1 token（mock Date tick）', (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    assert.deepEqual(takeRefreshToken('clinic-a'), { ok: true })
    assert.equal(takeRefreshToken('clinic-a').ok, false)
    t.mock.timers.tick(61_000)
    assert.deepEqual(takeRefreshToken('clinic-a'), { ok: true })
    t.mock.timers.reset()
  })

  it('retryAfterSec 唔會超過 60（refill 中）', () => {
    assert.deepEqual(takeRefreshToken('clinic-a'), { ok: true })
    const s = takeRefreshToken('clinic-a')
    if (!s.ok) assert.ok(s.retryAfterSec >= 1 && s.retryAfterSec <= 60)
  })

  it('resetExternalRateBuckets 一併清 refresh bucket', () => {
    assert.deepEqual(takeRefreshToken('clinic-a'), { ok: true })
    assert.equal(takeRefreshToken('clinic-a').ok, false)
    resetExternalRateBuckets()
    assert.deepEqual(takeRefreshToken('clinic-a'), { ok: true })
  })
})
