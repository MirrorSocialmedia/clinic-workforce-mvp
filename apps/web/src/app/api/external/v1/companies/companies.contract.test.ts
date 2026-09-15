/**
 * GET /api/external/v1/companies — contract test（cwi-followup-p0-20260915 S2 — MD §1.1）
 *
 * - fixture `test/fixtures/external-v1-companies.json` 過 zod schema + sha256 錨定（交 wa-inbox 對照）
 * - route 200 形狀 = schema 同形 + 負面 PII 斷言（機構代碼表 — 零電話/零病人資料）
 * - 401（缺/錯 key）／403（scope 無 org）
 * - clinics[].code = Clinic.shortName；shortName 空嘅 clinic 剔走
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
const FIXTURE_PATH = fileURLToPath(new URL('../../../../../../test/fixtures/external-v1-companies.json', import.meta.url))
const FIXTURE_SHA256 = 'e611ed9107c54e97ba6b0e4b90fb47202c704331f293669abf8ee56626896e85'
const PII_PATTERNS = ['phone', 'patient', 'email', 'address', 'bill']

// MD §1.1 200 形狀（zod — strict：多一個 key 就 fail）
const ClinicSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
}).strict()
const CompanySchema = z.object({
  companyApricotId: z.string().optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  clinics: z.array(ClinicSchema),
}).strict()
const CompaniesV1Schema = z.object({
  v: z.literal(1),
  companies: z.array(CompanySchema),
}).strict()

// ── 測試假 key（fixture 假值）────────────────────────────────────────
const KEY_ORG = 'ext-test-key-org-0000000000000000000000000000000000000000000000000000'
const KEY_NOSCOPE = 'ext-test-key-noscope-00000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const KEY_ROWS = [
  { id: 'k-org', name: 'contract-key-org', keyHash: sha(KEY_ORG), scopes: ['org', 'bookings'], active: true, lastUsedAt: null },
  { id: 'k-noscope', name: 'contract-key-noscope', keyHash: sha(KEY_NOSCOPE), scopes: ['availability'], active: true, lastUsedAt: null },
]

// ── 假數據（對齊 S0 dev fixture 形狀）─────────────────────────────────
const COMPANY_ROWS: Any[] = [
  { id: 'fup0cmpb0000000000000000002', name: '臻善' },
  { id: 'fup0cmpa0000000000000000001', name: '菁薈' },
  { id: 'e2e26cmp0000000000000000001', name: 'E2E26 Fixture Company' },
]
const CLINIC_ROWS: Any[] = [
  { id: 'fup0tycl0000000000000000001', name: 'TY 診所', shortName: 'TY', companyId: 'fup0cmpa0000000000000000001' },
  { id: 'fup0ymtc0000000000000000002', name: 'YMT 診所', shortName: 'YMT', companyId: 'fup0cmpb0000000000000000002' },
  { id: 'e2ereconcltw00000000001', name: 'E2E Recon TW 診所', shortName: 'TW', companyId: 'fup0cmpb0000000000000000002' },
  { id: 'e2ereconclmf00000000002', name: 'E2E Recon MF 診所', shortName: 'MF', companyId: 'fup0cmpb0000000000000000002' },
  { id: 'e2et2cln00000000000000001', name: 'E2E T2CACHE Fixture 診所', shortName: null, companyId: 'e2e26cmp0000000000000000001' },
  { id: 'cmtn52yi000053e5oci60v7o2', name: '仁愛診所', shortName: '', companyId: null }, // 無 code + 無公司 → 唔出現
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
  company: {
    findMany: async () => [...COMPANY_ROWS].sort((a, b) => a.name.localeCompare(b.name)),
  },
  clinic: {
    findMany: async () => CLINIC_ROWS,
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

function mkReq(key?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (key) headers['x-api-key'] = key
  return new NextRequest('http://localhost:3000/api/external/v1/companies', { headers })
}

function assertNoPiiKeys(body: unknown): void {
  const raw = JSON.stringify(body)
  for (const p of PII_PATTERNS) {
    assert.ok(!raw.includes(p), `response 含 PII 字樣：${p}`)
  }
}

// ── contract ─────────────────────────────────────────────────────────

describe('§1.1 — fixture + zod schema 契約', () => {
  it('fixture 檔存在 + sha256 錨定（wa-inbox 對照用）', () => {
    const raw = readFileSync(FIXTURE_PATH)
    const actual = createHash('sha256').update(raw).digest('hex')
    assert.equal(actual, FIXTURE_SHA256, 'fixture sha256 漂移 — 改咗 MD sample 要重新對')
  })

  it('fixture 過 zod schema（MD §1.1 200 形狀）', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    const parsed = CompaniesV1Schema.safeParse(fixture)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
  })
})

describe('route 行為', () => {
  it('200 形狀 = schema 同形 + 負面 PII 斷言 + clinics[].code = shortName', async () => {
    const res = await GET(mkReq(KEY_ORG))
    assert.equal(res.status, 200)
    const body = await res.json()
    const parsed = CompaniesV1Schema.safeParse(body)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
    assertNoPiiKeys(body)

    // 臻善 三間店 code 對 shortName + 排序
    const zs = body.companies.find((c: Any) => c.name === '臻善')
    assert.deepEqual(zs.clinics.map((c: Any) => c.code), ['MF', 'TW', 'YMT'])
    // 菁薈 一間
    assert.deepEqual(body.companies.find((c: Any) => c.name === '菁薈').clinics.map((c: Any) => c.code), ['TY'])
  })

  it('shortName 空嘅 clinic 剔走；零 clinic 公司仍出現（clinics: []）', async () => {
    const res = await GET(mkReq(KEY_ORG))
    const body = await res.json()
    const e2e26 = body.companies.find((c: Any) => c.id === 'e2e26cmp0000000000000000001')
    assert.deepEqual(e2e26.clinics, []) // shortName null → 剔
    // 仁愛診所（無公司 + 無 code）唔出現喺任何 companies[]
    assert.ok(!JSON.stringify(body).includes('仁愛診所'))
  })

  it('401 — 缺 key', async () => {
    const res = await GET(mkReq(undefined))
    assert.equal(res.status, 401)
  })

  it('401 — 錯 key', async () => {
    const res = await GET(mkReq('ext-test-key-wrong-0000000000000000000000000000000000000000000000000'))
    assert.equal(res.status, 401)
  })

  it('403 — scope 無 org（只有 availability）', async () => {
    const res = await GET(mkReq(KEY_NOSCOPE))
    assert.equal(res.status, 403)
  })

  it('audit 行落咗 + 零 PII', async () => {
    await GET(mkReq(KEY_ORG))
    assert.equal(auditCreates.length, 1)
    assert.equal(auditCreates[0].path, '/api/external/v1/companies')
    assertNoPiiKeys(auditCreates[0])
  })
})
