/**
 * GET /api/external/v1/availability — contract test + D 驗收（mock 版）
 * （MD §C.1 / §C.3 / §D）— cw-extapi-20260823-a1
 *
 * - fixture `test/fixtures/external-v1-availability.json`（MD sample 原樣）過 zod schema
 * - fixture sha256 錨定（Stage 4 wa-inbox 副本對照用）
 * - route 200 形狀 = schema 同形 + 負面斷言（response JSON.stringify 唔含 PII key）
 * - D：401（缺/錯 key）/ 403（scope）/ 429（狂打）/ 404 / 400 各款 / stale:true /
 *   audit 行有而零 PII
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from '../../../../../lib/prisma'
import { GET } from './route'

type Any = any

// ── fixture 錨定 ─────────────────────────────────────────────────────
const FIXTURE_PATH = fileURLToPath(new URL('../../../../../../test/fixtures/external-v1-availability.json', import.meta.url))
const FIXTURE_SHA256 = 'b23f5ec7cd87b1ff28c9dc8149da2798efe09112569e067de2f121b4572b448f'
const PII_PATTERNS = ['medicalHistory', 'personalIdentifier', 'visitReasons', 'phoneNum']

// MD §C.1 200 形狀（zod — strict：多一個 key 就 fail）
const SlotSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  isOpen: z.boolean(),
  bookedCount: z.number().int().min(0),
}).strict()
const ProviderSchema = z.object({
  providerApricotId: z.string().min(1),
  providerName: z.string().min(1),
  slots: z.array(SlotSchema),
}).strict()
const DaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providers: z.array(ProviderSchema),
}).strict()
const AvailabilityV1Schema = z.object({
  v: z.literal(1),
  clinicCode: z.string().min(1),
  syncedAt: z.string().nullable(),
  stale: z.boolean(),
  days: z.array(DaySchema),
}).strict()

// ── 測試假 key（fixture 假值）────────────────────────────────────────
const KEY_MAIN = 'ext-test-key-main-0000000000000000000000000000000000000000000000000000'
const KEY_NOSCOPE = 'ext-test-key-noscope-0000000000000000000000000000000000000000000000000000'
const KEY_BURST = 'ext-test-key-burst-0000000000000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const KEY_ROWS = [
  { id: 'k-main', name: 'contract-key-main', keyHash: sha(KEY_MAIN), scopes: ['availability', 'duty-roster'], active: true, lastUsedAt: null },
  { id: 'k-noscope', name: 'contract-key-noscope', keyHash: sha(KEY_NOSCOPE), scopes: ['duty-roster'], active: true, lastUsedAt: null },
  { id: 'k-burst', name: 'contract-key-burst', keyHash: sha(KEY_BURST), scopes: ['availability'], active: true, lastUsedAt: null },
]

// ── fake prisma ──────────────────────────────────────────────────────
const NOW = Date.now()
let cacheSyncedAt = new Date(NOW) // fresh（stale=false 預設）
const CACHE_ROWS: Any[] = [
  { providerApricotId: 'prov-lau', providerName: 'Dr. Lau', date: '2026-08-21', startTime: '10:00', endTime: '10:30', isOpen: true, bookedCount: 1, syncedAt: () => cacheSyncedAt },
  { providerApricotId: 'prov-lau', providerName: 'Dr. Lau', date: '2026-08-21', startTime: '10:30', endTime: '11:00', isOpen: true, bookedCount: 0, syncedAt: () => cacheSyncedAt },
  { providerApricotId: 'prov-tong', providerName: 'Dr. Tong', date: '2026-08-21', startTime: '10:00', endTime: '10:30', isOpen: true, bookedCount: 2, syncedAt: () => cacheSyncedAt },
]
// 上面 syncedAt 係 function 佔位 — 實際返回時換成真 Date（避免 module-load 固化）
const realCacheRows: Any[] = CACHE_ROWS.map(r => ({ ...r, syncedAt: () => cacheSyncedAt }))

const auditCreates: Any[] = []
const keyUpdates: Any[] = []
let clinicFound = true

const fakes = {
  externalApiKey: {
    findMany: async () => KEY_ROWS,
    update: async (args: Any) => { keyUpdates.push(args); return {} },
  },
  externalApiAudit: {
    create: async (args: Any) => { auditCreates.push(args.data); return {} },
  },
  clinic: {
    findFirst: async () => (clinicFound ? { id: 'cl-tkw', shortName: 'TKW' } : null),
  },
  availabilityCache: {
    findMany: async (args: Any) =>
      realCacheRows
        .filter((r: Any) => (args.where.date.gte ? r.date >= args.where.date.gte : true))
        .filter((r: Any) => (args.where.date.lte ? r.date <= args.where.date.lte : true))
        .filter((r: Any) => (args.where.providerApricotId ? r.providerApricotId === args.where.providerApricotId : true))
        .map((r: Any) => ({ ...r, syncedAt: cacheSyncedAt })),
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
  keyUpdates.length = 0
  clinicFound = true
  cacheSyncedAt = new Date(Date.now())
})

function mkReq(query: string, key?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (key) headers['x-api-key'] = key
  return new NextRequest(`http://localhost:3000/api/external/v1/availability?${query}`, { headers })
}

// ── C.3 contract ─────────────────────────────────────────────────────

describe('C.3 — fixture + zod schema 契約', () => {
  it('fixture 檔存在 + sha256 錨定（Stage 4 對照用）', () => {
    const raw = readFileSync(FIXTURE_PATH)
    const actual = createHash('sha256').update(raw).digest('hex')
    assert.equal(actual, FIXTURE_SHA256, 'fixture sha256 漂移 — 改咗 MD sample 要重新對')
  })

  it('fixture 過 zod schema（MD §C.1 200 形狀）', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    const parsed = AvailabilityV1Schema.safeParse(fixture)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
  })

  it('route 200 response 過 zod schema + 負面 PII 斷言', async () => {
    const res = await GET(mkReq('clinicCode=TKW&from=2026-08-21&to=2026-08-22', KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    const parsed = AvailabilityV1Schema.safeParse(body)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)

    // 負面斷言（MD 鐵律：response 零病人資料）
    const raw = JSON.stringify(body)
    for (const p of PII_PATTERNS) {
      assert.ok(!raw.includes(p), `response 含 PII key：${p}`)
    }

    // 內容抽查（同 seed 對）
    assert.equal(body.v, 1)
    assert.equal(body.clinicCode, 'TKW')
    assert.equal(body.stale, false)
    assert.equal(body.days.length, 2)
    assert.equal(body.days[0].providers[0].providerApricotId, 'prov-lau')
    assert.deepEqual(body.days[0].providers[0].slots[0], { start: '10:00', end: '10:30', isOpen: true, bookedCount: 1 })
    assert.equal(body.days[1].providers.length, 0) // 無數據日 → providers: []（確定性形狀）
  })

  it('providerApricotId 選填 filter', async () => {
    const res = await GET(mkReq('clinicCode=TKW&from=2026-08-21&to=2026-08-21&providerApricotId=prov-tong', KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.days[0].providers.length, 1)
    assert.equal(body.days[0].providers[0].providerApricotId, 'prov-tong')
    assert.equal(body.days[0].providers[0].slots[0].bookedCount, 2)
  })
})

// ── D 驗收（mock 版）─────────────────────────────────────────────────

describe('D — 驗收全項（mock）', () => {
  it('key 錯 → 401（缺 key / 錯 key）', async () => {
    const noKey = await GET(mkReq('clinicCode=TKW&from=2026-08-21&to=2026-08-21'))
    assert.equal(noKey.status, 401)
    assert.deepEqual(await noKey.json(), { error: 'missing key', code: 'UNAUTHORIZED' })

    const badKey = await GET(mkReq('clinicCode=TKW&from=2026-08-21&to=2026-08-21', 'ext-test-key-wrong-0000000000000000000000000000000000000000000000000000'))
    assert.equal(badKey.status, 401)
    assert.deepEqual(await badKey.json(), { error: 'invalid key', code: 'UNAUTHORIZED' })
  })

  it('scope 錯 → 403 FORBIDDEN', async () => {
    const res = await GET(mkReq('clinicCode=TKW&from=2026-08-21&to=2026-08-21', KEY_NOSCOPE))
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.code, 'FORBIDDEN')
    assert.match(body.error, /scope availability not granted/)
  })

  it('狂打 → 429 RATE_LIMITED（token bucket 60 burst）', async () => {
    let statusCounts: Record<number, number> = {}
    for (let i = 0; i < 61; i++) {
      const res = await GET(mkReq('clinicCode=TKW&from=2026-08-21&to=2026-08-21', KEY_BURST))
      statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1
    }
    assert.equal(statusCounts[200], 60)
    assert.equal(statusCounts[429], 1)
  })

  it('404 CLINIC_NOT_FOUND（未知 clinicCode）', async () => {
    clinicFound = false
    const res = await GET(mkReq('clinicCode=NOPE&from=2026-08-21&to=2026-08-21', KEY_MAIN))
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'clinic not found', code: 'CLINIC_NOT_FOUND' })
  })

  it('400：格式/範圍錯各款', async () => {
    const cases = [
      'from=2026-08-21&to=2026-08-21', // 缺 clinicCode
      'clinicCode=TKW&to=2026-08-21', // 缺 from
      'clinicCode=TKW&from=2026-08-21', // 缺 to
      'clinicCode=TKW&from=2026%2F08%2F21&to=2026-08-21', // 格式錯
      'clinicCode=TKW&from=2026-02-30&to=2026-02-30', // 偽日期
      'clinicCode=TKW&from=2026-08-21&to=2026-08-20', // to < from
      'clinicCode=TKW&from=2026-08-01&to=2026-09-02', // 32 日 > 31
    ]
    for (const q of cases) {
      const res = await GET(mkReq(q, KEY_MAIN))
      assert.equal(res.status, 400, `應該 400：${q}`)
      const body = await res.json()
      assert.equal(body.code, 'BAD_REQUEST')
    }
    // 恰好 31 日（0..31 差）OK
    const ok31 = await GET(mkReq('clinicCode=TKW&from=2026-08-01&to=2026-09-01', KEY_MAIN))
    assert.equal(ok31.status, 200)
  })

  it('stale：syncedAt 舊過 30 分鐘 → stale:true（手改 syncedAt）', async () => {
    cacheSyncedAt = new Date(Date.now() - 31 * 60 * 1000)
    const res = await GET(mkReq('clinicCode=TKW&from=2026-08-21&to=2026-08-21', KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.stale, true)
    assert.equal(body.syncedAt, cacheSyncedAt.toISOString())
  })

  it('audit：200 後有行、零 PII（keyName/path/status/latencyMs 四欄）', async () => {
    const res = await GET(mkReq('clinicCode=TKW&from=2026-08-21&to=2026-08-21', KEY_MAIN))
    assert.equal(res.status, 200)
    assert.ok(auditCreates.length >= 1)
    const row = auditCreates[auditCreates.length - 1]
    assert.deepEqual(Object.keys(row).sort(), ['keyName', 'latencyMs', 'path', 'status'])
    assert.equal(row.keyName, 'contract-key-main')
    assert.equal(row.path, '/api/external/v1/availability')
    assert.equal(row.status, 200)
    assert.equal(typeof row.latencyMs, 'number')
    // 零 query（audit 唔記 query string — 零 PII 鐵律）
    assert.ok(!String(row.path).includes('?'))
  })

  it('audit：401 亦有行（keyName = anonymous）', async () => {
    await GET(mkReq('clinicCode=TKW&from=2026-08-21&to=2026-08-21'))
    const row = auditCreates[auditCreates.length - 1]
    assert.equal(row.keyName, 'anonymous')
    assert.equal(row.status, 401)
  })
})
