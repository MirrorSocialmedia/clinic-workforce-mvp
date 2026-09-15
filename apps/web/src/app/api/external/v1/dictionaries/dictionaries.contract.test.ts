/**
 * GET /api/external/v1/dictionaries — contract test（cwi-followup-p0-20260915 S3 — MD §1.3）
 *
 * 現有 endpoint（cw-apricotwrite-20260823-a1）只讀 ApricotDictionary cache；
 * P0 開 bookings scope 畀 wa-inbox 用（VISIT_REASON 規則頁下拉數據源）。
 * 本 test 釘住：200 形狀 zod strict + isRemoved 剔走 + 400 kind + 401/403 矩陣 + 零 PII。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from '../../../../../lib/prisma'
import { GET } from './route'

type Any = any

const PII_PATTERNS = ['phone', 'patient', 'email', 'address', 'bill']

// 200 形狀（zod — strict）
const ItemSchema = z.object({
  apricotId: z.string().min(1),
  code: z.string().min(1),
  des: z.string().min(1),
}).strict()
const DictionariesV1Schema = z.object({
  v: z.literal(1),
  kind: z.enum(['VISIT_REASON', 'BOOKING_TYPE']),
  items: z.array(ItemSchema),
}).strict()

// ── 測試假 key（fixture 假值）────────────────────────────────────────
const KEY_BOOKINGS = 'ext-test-key-book-00000000000000000000000000000000000000000000000000'
const KEY_NOSCOPE = 'ext-test-key-noscope-00000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const KEY_ROWS = [
  { id: 'k-book', name: 'contract-key-bookings', keyHash: sha(KEY_BOOKINGS), scopes: ['bookings'], active: true, lastUsedAt: null },
  { id: 'k-noscope', name: 'contract-key-noscope', keyHash: sha(KEY_NOSCOPE), scopes: ['availability'], active: true, lastUsedAt: null },
]

// 對齊 MD §0.4 十個 code（dev seed 同一份數據）
const DICT_ROWS: Any[] = [
  { kind: 'VISIT_REASON', apricotId: 'fix00000000000000000012', code: '0012', des: 'FILLING', isRemoved: false },
  { kind: 'VISIT_REASON', apricotId: 'fix00000000000000000008', code: '0008', des: 'SP', isRemoved: false },
  { kind: 'VISIT_REASON', apricotId: 'fix00000000000000000021', code: '0021', des: 'CONSULTATION', isRemoved: false },
  { kind: 'VISIT_REASON', apricotId: 'fix00000000000000000056', code: '0056', des: 'DEBOND', isRemoved: true }, // 已撤 → 要剔走
]

const auditCreates: Any[] = []

const fakes = {
  externalApiKey: {
    findMany: async () => KEY_ROWS,
    update: async () => ({}),
  },
  externalApiAudit: {
    create: async (args: Any) => { auditCreates.push(args.data); return {} },
  },
  apricotDictionary: {
    findMany: async (args: Any) =>
      DICT_ROWS.filter((r) => r.kind === args.where.kind && (args.where.isRemoved === undefined ? true : r.isRemoved === args.where.isRemoved))
        .map(({ isRemoved, ...rest }) => rest)
        .sort((a, b) => a.code.localeCompare(b.code)),
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
  auditCreates.length = 0
})

function mkReq(query: string, key?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (key) headers['x-api-key'] = key
  return new NextRequest(`http://localhost:3000/api/external/v1/dictionaries?${query}`, { headers })
}

function assertNoPiiKeys(body: unknown): void {
  const raw = JSON.stringify(body)
  for (const p of PII_PATTERNS) {
    assert.ok(!raw.includes(p), `response 含 PII 字樣：${p}`)
  }
}

describe('route 行為', () => {
  it('200 VISIT_REASON 形狀 zod strict + code 排序 + 零 PII', async () => {
    const res = await GET(mkReq('kind=VISIT_REASON', KEY_BOOKINGS))
    assert.equal(res.status, 200)
    const body = await res.json()
    const parsed = DictionariesV1Schema.safeParse(body)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
    assert.equal(body.kind, 'VISIT_REASON')
    assert.deepEqual(body.items.map((i: Any) => i.code), ['0008', '0012', '0021'])
    assertNoPiiKeys(body)
  })

  it('isRemoved 剔走', async () => {
    const res = await GET(mkReq('kind=VISIT_REASON', KEY_BOOKINGS))
    const body = await res.json()
    assert.ok(!body.items.some((i: Any) => i.apricotId === 'fix00000000000000000056'))
  })

  it('400 — kind 錯 / 缺', async () => {
    assert.equal((await GET(mkReq('kind=BOGUS', KEY_BOOKINGS))).status, 400)
    assert.equal((await GET(mkReq('', KEY_BOOKINGS))).status, 400)
  })

  it('401 — 缺 key / 錯 key', async () => {
    assert.equal((await GET(mkReq('kind=VISIT_REASON'))).status, 401)
    assert.equal((await GET(mkReq('kind=VISIT_REASON', 'ext-test-key-wrong-0000000000000000000000000000000000000000000000000'))).status, 401)
  })

  it('403 — scope 無 bookings（只有 availability）', async () => {
    assert.equal((await GET(mkReq('kind=VISIT_REASON', KEY_NOSCOPE))).status, 403)
  })

  it('audit 行落咗 + 零 PII', async () => {
    await GET(mkReq('kind=VISIT_REASON', KEY_BOOKINGS))
    assert.equal(auditCreates.length, 1)
    assert.equal(auditCreates[0].path, '/api/external/v1/dictionaries')
    assertNoPiiKeys(auditCreates[0])
  })
})
