/**
 * GET /api/external/v1/quotes + GET /quotes/{id} + POST /quotes/{id}/decision
 * — cwi-final S5-13①（F5）contract test（mock 版 — fake prisma monkey-patch）
 *
 * 覆蓋（T820–T823）：
 *   - T820：clinicIds（cuid）filter 命中／唔命中 + clinicCodes（shortName 兼容）
 *     + 未識 code → 400 CLINIC_CODE_NOT_FOUND + 兩者同傳 = union
 *   - T821：單條 endpoint 200 同列表 item 同 shape / 404 QUOTE_NOT_FOUND
 *   - T822：decision 只准 pending/corrected（confirmed/discarded → 409）；
 *     correctionNote 頂層同 fields 都收（頂層優先）
 *   - T823：teachTerm upsert 唔改 active（admin 停用咗嘅詞唔好被復活）
 *
 * 守門（401/403）照 patient-lookup contract 同口徑，唔重複釘。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from '../../../../../lib/prisma'
import { GET as listGET } from './route'
import { GET as singleGET } from './[id]/route'
import { POST as decisionPOST } from './[id]/decision/route'

type Any = any

// ── 測試假 key ─────────────────────────────────────────────────────
const KEY_MAIN = 'ext-test-key-main-0000000000000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const KEY_ROWS = [
  { id: 'k-main', name: 'contract-key-main', keyHash: sha(KEY_MAIN), scopes: ['patients'], active: true, lastUsedAt: null },
]

// ── fake 數據 ──────────────────────────────────────────────────────
const CLINICS: Any[] = [
  { id: 'cl-tkw', shortName: 'TKW' },
  { id: 'cl-rsm', shortName: 'RSM' },
]
const QUOTES: Any[] = [
  { id: 'q-tkw-1', clinicId: 'cl-tkw', patientApricotId: 'pt-1', sourceVisitDate: new Date('2026-09-01T00:00:00Z'), text: '補牙', termShorthand: null, nameCn: null, amountMin: 300, amountMax: 500, perUnit: false, fdiTeeth: [], intent: 'unknown', certainty: 'low', source: 'parser', status: 'pending', correctionNote: null },
  { id: 'q-tkw-2', clinicId: 'cl-tkw', patientApricotId: 'pt-1', sourceVisitDate: new Date('2026-09-02T00:00:00Z'), text: '洗牙', termShorthand: null, nameCn: null, amountMin: 200, amountMax: 200, perUnit: false, fdiTeeth: [], intent: 'unknown', certainty: 'low', source: 'parser', status: 'confirmed', correctionNote: null },
  { id: 'q-rsm-1', clinicId: 'cl-rsm', patientApricotId: 'pt-2', sourceVisitDate: new Date('2026-09-03T00:00:00Z'), text: '根管', termShorthand: null, nameCn: null, amountMin: 1500, amountMax: 2500, perUnit: true, fdiTeeth: ['21'], intent: 'not_done', certainty: 'high', source: 'llm', status: 'corrected', correctionNote: null },
]
let termRows: Any[] = []
const auditCreates: Any[] = []

const fakes = {
  externalApiKey: { findMany: async () => KEY_ROWS, update: async () => ({}) },
  externalApiAudit: { create: async (args: Any) => { auditCreates.push(args.data); return {} } },
  clinic: {
    findMany: async ({ where }: Any) =>
      CLINICS.filter((c) => (where?.shortName?.in ? where.shortName.in.includes(c.shortName) : where?.id?.in ? where.id.in.includes(c.id) : true)),
  },
  quotedItem: {
    findMany: async ({ where }: Any) =>
      QUOTES.filter((q) =>
        (where.patientApricotId ? q.patientApricotId === where.patientApricotId : true) &&
        (where.clinicId?.in ? where.clinicId.in.includes(q.clinicId) : true) &&
        (where.status?.in ? where.status.in.includes(q.status) : true)
      ),
    findUnique: async ({ where }: Any) => QUOTES.find((q) => q.id === where.id) ?? null,
    update: async ({ where, data }: Any) => {
      const q = QUOTES.find((x) => x.id === where.id)
      Object.assign(q, data)
      return q
    },
  },
  clinicalTermMap: {
    upsert: async ({ where, create, update }: Any) => {
      const hit = termRows.find((t) => t.shorthand === where.shorthand)
      if (hit) Object.assign(hit, update)
      else { termRows.push({ active: true, ...create }); return { ...create, active: true } }
      return hit
    },
    findMany: async () => termRows,
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
  termRows = []
  // 還原 quote 狀態（decision 測試會改）
  QUOTES[0].status = 'pending'; QUOTES[0].correctionNote = null
  QUOTES[1].status = 'confirmed'; QUOTES[1].correctionNote = null
  QUOTES[2].status = 'corrected'; QUOTES[2].correctionNote = null
})

function mkReq(path: string, key?: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }): NextRequest {
  const headers: Record<string, string> = {}
  if (key) headers['x-api-key'] = key
  if (opts?.headers) Object.assign(headers, opts.headers)
  return new NextRequest(`http://localhost:3000${path}`, {
    headers,
    ...(opts?.method ? { method: opts.method } : {}),
    ...(opts?.body !== undefined ? { body: opts.body } : {}),
  })
}

// 列表 item 白名單（同 route 回傳 1:1 — 零原始電話／零全文）
const QuoteItemSchema = z.object({
  id: z.string().min(1),
  patientApricotId: z.string().min(1),
  clinicCode: z.string().min(1),
  sourceVisitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  text: z.string(),
  termShorthand: z.string().nullable(),
  nameCn: z.string().nullable(),
  amountMin: z.number().nullable(),
  amountMax: z.number().nullable(),
  perUnit: z.boolean(),
  fdiTeeth: z.array(z.string()),
  intent: z.string(),
  certainty: z.string(),
  source: z.string(),
  status: z.enum(['pending', 'confirmed', 'corrected', 'discarded']),
}).strict()

// ── T820：clinic filter ─────────────────────────────────────────────
describe('T820 S5-13①：quotes clinic filter（clinicIds cuid + clinicCodes 兼容）', () => {
  it('clinicIds（cuid）命中：只回該店 + item 過 strict schema', async () => {
    const res = await listGET(mkReq('/api/external/v1/quotes?clinicIds=cl-tkw', KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.v, 1)
    assert.deepEqual(body.quotes.map((q: Any) => q.id).sort(), ['q-tkw-1', 'q-tkw-2'])
    for (const q of body.quotes) {
      assert.equal(q.clinicCode, 'TKW')
      assert.ok(QuoteItemSchema.safeParse(q).success)
    }
  })

  it('clinicIds 唔命中 → 空陣列（唔係錯）', async () => {
    const res = await listGET(mkReq('/api/external/v1/quotes?clinicIds=cl-unknown-cuid', KEY_MAIN))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { v: 1, quotes: [] })
  })

  it('clinicCodes（shortName 兼容）命中：多店 union', async () => {
    const res = await listGET(mkReq('/api/external/v1/quotes?clinicCodes=RSM', KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.quotes.map((q: Any) => q.id), ['q-rsm-1'])
    assert.equal(body.quotes[0].clinicCode, 'RSM')
  })

  it('clinicIds + clinicCodes 同傳 = union', async () => {
    // q-tkw-1 已 pending；q-rsm-1 corrected → 預設 status 集合（pending+confirmed+corrected）全收
    const res = await listGET(mkReq('/api/external/v1/quotes?clinicIds=cl-tkw&clinicCodes=RSM&status=pending,corrected', KEY_MAIN))
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json()).quotes.map((q: Any) => q.id).sort(), ['q-rsm-1', 'q-tkw-1'])
  })

  it('clinicCodes 未識 code → 400 CLINIC_CODE_NOT_FOUND（唔好靜默空返）', async () => {
    const res = await listGET(mkReq('/api/external/v1/quotes?clinicCodes=TKW,XXX', KEY_MAIN))
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.code, 'CLINIC_CODE_NOT_FOUND')
    assert.match(body.error, /XXX/)
  })

  it('唔傳 clinic 參數 = 舊行為（全店 — 後向兼容）', async () => {
    const res = await listGET(mkReq('/api/external/v1/quotes', KEY_MAIN))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).quotes.length, 3)
  })
})

// ── T821：單條 endpoint ─────────────────────────────────────────────
describe('T821 S5-13①：GET /quotes/{id} 單條（同列表 shape）', () => {
  it('200：{ v:1, quote } 同列表 item 同 shape（含 clinicCode）', async () => {
    const res = await singleGET(mkReq('/api/external/v1/quotes/q-rsm-1', KEY_MAIN), { params: Promise.resolve({ id: 'q-rsm-1' }) })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.v, 1)
    assert.equal(body.quote.id, 'q-rsm-1')
    assert.equal(body.quote.clinicCode, 'RSM')
    assert.ok(QuoteItemSchema.safeParse(body.quote).success)
    // 同列表 item 完全同 shape（key set 一致）
    const listRes = await listGET(mkReq('/api/external/v1/quotes?clinicIds=cl-rsm', KEY_MAIN))
    const listItem = (await listRes.json()).quotes[0]
    assert.deepEqual(Object.keys(body.quote).sort(), Object.keys(listItem).sort())
  })

  it('404：QUOTE_NOT_FOUND', async () => {
    const res = await singleGET(mkReq('/api/external/v1/quotes/q-nope', KEY_MAIN), { params: Promise.resolve({ id: 'q-nope' }) })
    assert.equal(res.status, 404)
    assert.equal((await res.json()).code, 'QUOTE_NOT_FOUND')
  })
})

// ── T822：decision 狀態 + correctionNote ─────────────────────────────
describe('T822 S5-13①：decision 只准 pending/corrected + correctionNote 雙層', () => {
  it('pending → confirm 200（頂層 correctionNote 照收）', async () => {
    const res = await decisionPOST(
      mkReq('/api/external/v1/quotes/q-tkw-1/decision', KEY_MAIN, { method: 'POST', body: JSON.stringify({ action: 'confirm', correctionNote: 'ok 收貨' }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: 'q-tkw-1' }) },
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'confirmed')
    assert.equal(QUOTES[0].correctionNote, 'ok 收貨')
  })

  it('confirmed → 再 decision → 409 QUOTE_NOT_DECIDABLE', async () => {
    const res = await decisionPOST(
      mkReq('/api/external/v1/quotes/q-tkw-2/decision', KEY_MAIN, { method: 'POST', body: JSON.stringify({ action: 'confirm' }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: 'q-tkw-2' }) },
    )
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.equal(body.code, 'QUOTE_NOT_DECIDABLE')
  })

  it('discarded → 409（已定案唔可逆）', async () => {
    QUOTES[1].status = 'discarded'
    const res = await decisionPOST(
      mkReq('/api/external/v1/quotes/q-tkw-2/decision', KEY_MAIN, { method: 'POST', body: JSON.stringify({ action: 'correct', fields: { amountMin: 1 } }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: 'q-tkw-2' }) },
    )
    assert.equal(res.status, 409)
  })

  it('corrected → 可再 correct（200）', async () => {
    const res = await decisionPOST(
      mkReq('/api/external/v1/quotes/q-rsm-1/decision', KEY_MAIN, { method: 'POST', body: JSON.stringify({ action: 'correct', fields: { amountMin: 1600 } }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: 'q-rsm-1' }) },
    )
    assert.equal(res.status, 200)
    assert.equal(QUOTES[2].amountMin, 1600)
  })

  it('correctionNote：fields 層收（correct）', async () => {
    const res = await decisionPOST(
      mkReq('/api/external/v1/quotes/q-rsm-1/decision', KEY_MAIN, { method: 'POST', body: JSON.stringify({ action: 'correct', fields: { correctionNote: '價錢唔對' } }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: 'q-rsm-1' }) },
    )
    assert.equal(res.status, 200)
    assert.equal(QUOTES[2].correctionNote, '價錢唔對')
  })

  it('correctionNote：頂層同 fields 都傳 → 頂層優先', async () => {
    const res = await decisionPOST(
      mkReq('/api/external/v1/quotes/q-rsm-1/decision', KEY_MAIN, { method: 'POST', body: JSON.stringify({ action: 'correct', correctionNote: '頂層版', fields: { correctionNote: 'fields 版' } }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: 'q-rsm-1' }) },
    )
    assert.equal(res.status, 200)
    assert.equal(QUOTES[2].correctionNote, '頂層版')
  })
})

// ── T823：teachTerm 唔改 active ──────────────────────────────────────
describe('T823 S5-13①：teachTerm upsert 唔改 active（唔復活停用詞）', () => {
  it('既有 active 詞 → 更新 nameCn/nameEn，active 照 true', async () => {
    termRows.push({ shorthand: 'fill', nameCn: '舊名', nameEn: null, usedFor: ['quote_extraction'], active: true })
    const res = await decisionPOST(
      mkReq('/api/external/v1/quotes/q-tkw-1/decision', KEY_MAIN, {
        method: 'POST',
        body: JSON.stringify({ action: 'confirm', teachTerm: { shorthand: 'fill', nameCn: '充填', nameEn: 'filling' } }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'q-tkw-1' }) },
    )
    assert.equal(res.status, 200)
    assert.equal((await res.json()).termMapUpserted, true)
    assert.equal(termRows[0].nameCn, '充填')
    assert.equal(termRows[0].nameEn, 'filling')
    assert.equal(termRows[0].active, true)
  })

  it('admin 停用咗嘅詞（active=false）→ teach 後 active 仍 false（唔復活）', async () => {
    termRows.push({ shorthand: 'dead', nameCn: '停用詞', nameEn: null, usedFor: ['quote_extraction'], active: false })
    const res = await decisionPOST(
      mkReq('/api/external/v1/quotes/q-tkw-1/decision', KEY_MAIN, {
        method: 'POST',
        body: JSON.stringify({ action: 'confirm', teachTerm: { shorthand: 'dead', nameCn: '新名' } }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'q-tkw-1' }) },
    )
    assert.equal(res.status, 200)
    assert.equal(termRows[0].nameCn, '新名')
    assert.equal(termRows[0].active, false, 'active 唔可以俾 teachTerm 復活')
  })

  it('新詞 → create（active 預設 true）', async () => {
    const res = await decisionPOST(
      mkReq('/api/external/v1/quotes/q-tkw-1/decision', KEY_MAIN, {
        method: 'POST',
        body: JSON.stringify({ action: 'confirm', teachTerm: { shorthand: 'new', nameCn: '新術語' } }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'q-tkw-1' }) },
    )
    assert.equal(res.status, 200)
    const created = termRows.find((t) => t.shorthand === 'new')
    assert.ok(created)
    assert.equal(created.active, true)
  })
})
