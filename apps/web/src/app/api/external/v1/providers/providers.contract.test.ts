/**
 * GET /api/external/v1/providers — contract test（cwm-roster-20261001）
 *
 * - fixture `test/fixtures/external-v1-providers.json` 過 zod strict schema + sha256 錨定（wa-inbox 副本對照）
 * - 同一個醫生喺兩個 Apricot 帳號（MAIN／TY）→ 各店回各自嘅 practitioner id，providerId 一樣
 * - kind=CLINIC 剔走、停用醫生剔走、未綁 → providerId null（名用 Apricot 快照）
 * - stale／clinicCode 篩選／404／401／403／零 PII
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from '../../../../../lib/prisma'
import { GET } from './route'

type Any = any

const FIXTURE_PATH = fileURLToPath(new URL('../../../../../../test/fixtures/external-v1-providers.json', import.meta.url))
const FIXTURE_SHA256 = '4efbeda074f23325553f2e1bbf2aa08f88a3685df8c8430019cd1b0164114bf3'
const PII_PATTERNS = ['patientName', 'phoneHash', 'phoneNum', 'medicalHistory', 'personalIdentifier']

const ProviderSchema = z.object({
  apricotId: z.string().min(1),
  name: z.string().min(1),
  providerId: z.string().min(1).nullable(),
}).strict()
const ClinicSchema = z.object({
  clinicId: z.string().min(1),
  clinicCode: z.string().min(1),
  apricotAccount: z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/),
  syncedAt: z.string().nullable(),
  stale: z.boolean(),
  providers: z.array(ProviderSchema),
}).strict()
const ProvidersV1Schema = z.object({ v: z.literal(1), clinics: z.array(ClinicSchema) }).strict()

const KEY_MAIN = 'ext-test-key-prov-00000000000000000000000000000000000000000000000000'
const KEY_NOSCOPE = 'ext-test-key-prov-noscope-000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const KEY_ROWS = [
  { id: 'k-main', name: 'contract-key-prov', keyHash: sha(KEY_MAIN), scopes: ['availability'], active: true, lastUsedAt: null },
  { id: 'k-noscope', name: 'contract-key-noscope', keyHash: sha(KEY_NOSCOPE), scopes: ['bookings'], active: true, lastUsedAt: null },
]

const NOW = Date.now()
const fresh = new Date(NOW - 60_000)
const old = new Date(NOW - 2 * 3_600_000)
const FUTURE = '2099-01-01'
const PAST = '2000-01-01'
const CLINICS = [
  { id: 'cl-mf', name: 'MF 店', shortName: 'MF', apricotClinicId: 'a'.repeat(24), apricotAccount: 'MAIN' },
  { id: 'cl-ty', name: '青衣', shortName: 'TY', apricotClinicId: 'b'.repeat(24), apricotAccount: 'TY' },
  { id: 'cl-old', name: '舊店', shortName: 'OLD', apricotClinicId: 'c'.repeat(24), apricotAccount: 'MAIN' },
]
const CACHE = [
  { clinicId: 'cl-mf', providerApricotId: 'mf-wong', providerName: 'Wong (Apricot)', date: FUTURE, syncedAt: fresh },
  { clinicId: 'cl-mf', providerApricotId: 'mf-wong', providerName: 'Wong (Apricot)', date: FUTURE, syncedAt: fresh }, // 同人多 slot
  { clinicId: 'cl-mf', providerApricotId: 'mf-gone', providerName: 'Gone', date: PAST, syncedAt: fresh },             // 過去 → 唔計
  { clinicId: 'cl-ty', providerApricotId: 'ty-wong', providerName: 'Wong TY (Apricot)', date: FUTURE, syncedAt: fresh },
  { clinicId: 'cl-ty', providerApricotId: 'ty-clinic', providerName: 'TY Clinic', date: FUTURE, syncedAt: fresh },   // kind CLINIC → 剔
  { clinicId: 'cl-ty', providerApricotId: 'ty-new', providerName: 'Dr. New', date: FUTURE, syncedAt: fresh },        // 未綁
  { clinicId: 'cl-ty', providerApricotId: 'ty-left', providerName: 'Left', date: FUTURE, syncedAt: fresh },          // 已停用
  { clinicId: 'cl-old', providerApricotId: 'old-x', providerName: 'X', date: FUTURE, syncedAt: old },                // stale
]
const ACCTS = [
  { apricotId: 'mf-wong', kind: 'PROVIDER', providerId: 'prov-wong', provider: { name: '王醫生', isActive: true } },
  { apricotId: 'ty-wong', kind: 'PROVIDER', providerId: 'prov-wong', provider: { name: '王醫生', isActive: true } },
  { apricotId: 'ty-clinic', kind: 'CLINIC', providerId: null, provider: null },
  { apricotId: 'ty-left', kind: 'PROVIDER', providerId: 'prov-left', provider: { name: '離職醫生', isActive: false } },
]
const auditCreates: Any[] = []

const fakes: Record<string, Any> = {
  externalApiKey: { findMany: async () => KEY_ROWS, update: async () => ({}) },
  externalApiAudit: { create: async (a: Any) => { auditCreates.push(a.data); return {} } },
  clinic: {
    findUnique: async ({ where }: Any) => CLINICS.find(c => c.id === where.id) ?? null,
    findMany: async ({ where }: Any) => where?.shortName !== undefined
      ? CLINICS.filter(c => c.shortName === where.shortName).slice(0, 2)
      : CLINICS.filter(c => c.apricotClinicId),
  },
  availabilityCache: {
    findMany: async ({ where }: Any) => CACHE.filter(r => where.clinicId.in.includes(r.clinicId) && r.date >= where.date.gte),
  },
  apricotPractitioner: {
    findMany: async ({ where }: Any) => ACCTS.filter(a => where.apricotId.in.includes(a.apricotId)),
  },
}
const saved: [Any, string, Any][] = []
before(() => {
  for (const obj of [prisma, basePrisma]) for (const k of Object.keys(fakes)) {
    saved.push([obj, k, (obj as Any)[k]])
    Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
  }
})
after(() => { for (const [obj, k, orig] of saved) Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true }) })

const mkReq = (q: string, key?: string) =>
  new NextRequest(`http://localhost:3000/api/external/v1/providers${q}`, { headers: key ? { 'x-api-key': key } : {} })

describe('fixture 契約', () => {
  it('sha256 錨定 + 過 zod strict', () => {
    const raw = readFileSync(FIXTURE_PATH, 'utf8')
    assert.equal(createHash('sha256').update(raw, 'utf8').digest('hex'), FIXTURE_SHA256)
    const parsed = ProvidersV1Schema.safeParse(JSON.parse(raw))
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  })
})

describe('route 行為', () => {
  it('200 全部店：形狀 strict、零 PII', async () => {
    const res = await GET(mkReq('', KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    const parsed = ProvidersV1Schema.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
    const raw = JSON.stringify(body)
    for (const p of PII_PATTERNS) assert.ok(!raw.includes(p), p)
  })

  it('同一個醫生兩個帳號 → 各店回各自 practitioner id，providerId／名一樣', async () => {
    const body = await (await GET(mkReq('', KEY_MAIN))).json()
    const mf = body.clinics.find((c: Any) => c.clinicCode === 'MF')
    const ty = body.clinics.find((c: Any) => c.clinicCode === 'TY')
    assert.equal(mf.apricotAccount, 'MAIN')
    assert.equal(ty.apricotAccount, 'TY')
    assert.deepEqual(mf.providers, [{ apricotId: 'mf-wong', name: '王醫生', providerId: 'prov-wong' }])
    const tyWong = ty.providers.find((p: Any) => p.providerId === 'prov-wong')
    assert.equal(tyWong.apricotId, 'ty-wong')
    assert.equal(tyWong.name, '王醫生')
  })

  it('kind=CLINIC／停用醫生剔走；未綁 → providerId null + Apricot 名；過去日唔計', async () => {
    const body = await (await GET(mkReq('', KEY_MAIN))).json()
    const ty = body.clinics.find((c: Any) => c.clinicCode === 'TY')
    const ids = ty.providers.map((p: Any) => p.apricotId)
    assert.ok(!ids.includes('ty-clinic'))
    assert.ok(!ids.includes('ty-left'))
    assert.deepEqual(ty.providers.find((p: Any) => p.apricotId === 'ty-new'), { apricotId: 'ty-new', name: 'Dr. New', providerId: null })
    const mf = body.clinics.find((c: Any) => c.clinicCode === 'MF')
    assert.ok(!mf.providers.some((p: Any) => p.apricotId === 'mf-gone'))
  })

  it('stale：syncedAt > 30 分鐘 → stale true', async () => {
    const body = await (await GET(mkReq('', KEY_MAIN))).json()
    assert.equal(body.clinics.find((c: Any) => c.clinicCode === 'OLD').stale, true)
    assert.equal(body.clinics.find((c: Any) => c.clinicCode === 'TY').stale, false)
  })

  it('clinicCode 篩選；搵唔到店 → 404', async () => {
    const body = await (await GET(mkReq('?clinicCode=TY', KEY_MAIN))).json()
    assert.deepEqual(body.clinics.map((c: Any) => c.clinicCode), ['TY'])
    assert.equal((await GET(mkReq('?clinicCode=NOPE', KEY_MAIN))).status, 404)
  })

  it('401 缺 key／403 scope 唔啱；audit 有行', async () => {
    assert.equal((await GET(mkReq(''))).status, 401)
    assert.equal((await GET(mkReq('', KEY_NOSCOPE))).status, 403)
    assert.ok(auditCreates.some(a => a.path === '/api/external/v1/providers'))
  })
})
