/**
 * GET /api/external/v1/patient-lookup — contract test（read-chain MD §4.1/§4.4）
 * cwc-rdchain-20260823-b1
 *
 * - fixture `test/fixtures/external-v1-patient-lookup.json`（MD sample 原樣）過 zod schema
 * - fixture sha256 錨定（交 wa-inbox 對同一 hash）
 * - route 200 形狀 = schema 同形 + 負面 PII 斷言（序列化唔含 PII key）
 * - 驗收：多 match 全回／零 match 200 空陣列／lastVisit = 最近過去行（未來行唔計；冇 → null）
 * - 401（缺/錯 key）／403（scope）／400（phoneHash 格式）／audit 行零 PII
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from '../../../../../lib/prisma'
import { toHKDateStr, addDaysStr } from '../../../../../lib/hk-date'
import { GET } from './route'

type Any = any

// ── fixture 錨定 ─────────────────────────────────────────────────────
const FIXTURE_PATH = fileURLToPath(new URL('../../../../../../test/fixtures/external-v1-patient-lookup.json', import.meta.url))
const FIXTURE_SHA256 = '5db38929d527abcdc32ae17e72e04c2e43ec6b2db10b3e01d9a104324990066e'
const PII_PATTERNS = ['medicalHistory', 'personalIdentity', 'address', 'phoneNum']

// MD §4.1 200 形狀（zod — strict：多一個 key 就 fail）
const LastVisitSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providerName: z.string().min(1),
  visitReasons: z.array(z.string()),
}).strict()
const MatchSchema = z.object({
  patientApricotId: z.string().min(1),
  patientCode: z.string().min(1),
  patientName: z.string().min(1),
  lastVisit: LastVisitSchema.nullable(),
}).strict()
const PatientLookupV1Schema = z.object({
  v: z.literal(1),
  matches: z.array(MatchSchema),
}).strict()

// ── 測試假 key（fixture 假值）────────────────────────────────────────
const KEY_MAIN = 'ext-test-key-main-0000000000000000000000000000000000000000000000000000'
const KEY_NOSCOPE = 'ext-test-key-noscope-0000000000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const KEY_ROWS = [
  { id: 'k-main', name: 'contract-key-main', keyHash: sha(KEY_MAIN), scopes: ['patients', 'appointments'], active: true, lastUsedAt: null },
  { id: 'k-noscope', name: 'contract-key-noscope', keyHash: sha(KEY_NOSCOPE), scopes: ['availability'], active: true, lastUsedAt: null },
]

// ── fake prisma（日期相對於今日 — 測試永唔會因日期過時而壞）──────────
const TODAY = toHKDateStr(new Date())
const HASH_A = 'a'.repeat(64)
const HASH_C = 'c'.repeat(64)

const PATIENT_ROWS: Any[] = [
  { patientApricotId: 'pt-1', patientCode: 'TKW001991', patientName: '陳大文', phoneHash: HASH_A },
  { patientApricotId: 'pt-2', patientCode: 'TKW001992', patientName: '陳小明', phoneHash: HASH_A },
  { patientApricotId: 'pt-3', patientCode: 'TKW001993', patientName: '張豐', phoneHash: HASH_C },
]
const APPT_ROWS: Any[] = [
  // pt-1：兩行過去 → lastVisit 應係最近嗰行（TODAY-2）
  { patientApricotId: 'pt-1', date: addDaysStr(TODAY, -5), startTime: '10:00', providerName: 'Dr. Tong', visitReasons: ['EXAMINATION'] },
  { patientApricotId: 'pt-1', date: addDaysStr(TODAY, -2), startTime: '09:00', providerName: 'Dr. Lau', visitReasons: ['FILLING'] },
  // pt-2：只有未來行 → lastVisit 應係 null（未发生唔算到診）
  { patientApricotId: 'pt-2', date: addDaysStr(TODAY, +3), startTime: '09:00', providerName: 'Dr. Lau', visitReasons: ['RECALL'] },
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
  patientIndex: {
    findMany: async (args: Any) =>
      PATIENT_ROWS.filter(r => r.phoneHash === args.where.phoneHash).map(({ phoneHash, ...rest }) => rest),
  },
  appointmentIndex: {
    findMany: async (args: Any) =>
      APPT_ROWS
        .filter(r => args.where.patientApricotId?.in?.includes(r.patientApricotId) ?? false)
        .filter(r => (args.where.date?.lte ? r.date <= args.where.date.lte : true))
        .sort((a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime)),
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
  return new NextRequest(`http://localhost:3000/api/external/v1/patient-lookup?${query}`, { headers })
}

function assertNoPiiKeys(body: unknown): void {
  const raw = JSON.stringify(body)
  for (const p of PII_PATTERNS) {
    assert.ok(!raw.includes(p), `response 含 PII key：${p}`)
  }
}

// ── contract ─────────────────────────────────────────────────────────

describe('§4.4 — fixture + zod schema 契約', () => {
  it('fixture 檔存在 + sha256 錨定（wa-inbox 對照用）', () => {
    const raw = readFileSync(FIXTURE_PATH)
    const actual = createHash('sha256').update(raw).digest('hex')
    assert.equal(actual, FIXTURE_SHA256, 'fixture sha256 漂移 — 改咗 MD sample 要重新對')
  })

  it('fixture 過 zod schema（MD §4.1 200 形狀）', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    const parsed = PatientLookupV1Schema.safeParse(fixture)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
  })

  it('route 200 response 過 zod schema + 負面 PII 斷言', async () => {
    const res = await GET(mkReq(`phoneHash=${HASH_A}`, KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    const parsed = PatientLookupV1Schema.safeParse(body)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
    assertNoPiiKeys(body)
  })
})

// ── §4.1 驗收（mock）─────────────────────────────────────────────────

describe('§4.1 — 驗收全項（mock）', () => {
  it('多 match 全回（同一 phoneHash 兩病人）+ lastVisit = 最近過去行', async () => {
    const res = await GET(mkReq(`phoneHash=${HASH_A}`, KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.v, 1)
    assert.equal(body.matches.length, 2)
    // 排序（patientCode asc）
    assert.deepEqual(body.matches.map((m: Any) => m.patientCode), ['TKW001991', 'TKW001992'])
    // pt-1：最近過去行 = TODAY-2（唔係 TODAY-5）
    assert.deepEqual(body.matches[0].lastVisit, {
      date: addDaysStr(TODAY, -2),
      providerName: 'Dr. Lau',
      visitReasons: ['FILLING'],
    })
    assert.equal(body.matches[0].patientApricotId, 'pt-1')
    assert.equal(body.matches[0].patientName, '陳大文')
  })

  it('lastVisit：只有未來行 → null（未发生唔算到診）', async () => {
    const res = await GET(mkReq(`phoneHash=${HASH_A}`, KEY_MAIN))
    const body = await res.json()
    assert.equal(body.matches[1].patientCode, 'TKW001992')
    assert.equal(body.matches[1].lastVisit, null)
  })

  it('零 match → 200 空陣列', async () => {
    const HASH_NONE = 'd'.repeat(64)
    const res = await GET(mkReq(`phoneHash=${HASH_NONE}`, KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { v: 1, matches: [] })
    assertNoPiiKeys(body)
  })

  it('400：phoneHash 缺／格式錯', async () => {
    const cases = ['', 'phoneHash=', 'phoneHash=abc123', `phoneHash=${'z'.repeat(64)}`, `phoneHash=${'a'.repeat(63)}`]
    for (const q of cases) {
      const res = await GET(mkReq(q, KEY_MAIN))
      assert.equal(res.status, 400, `應該 400：${q || '(empty)'}`)
      const body = await res.json()
      assert.equal(body.code, 'BAD_REQUEST')
    }
  })

  it('key 錯 → 401（缺 key / 錯 key）', async () => {
    const noKey = await GET(mkReq(`phoneHash=${HASH_A}`))
    assert.equal(noKey.status, 401)
    assert.deepEqual(await noKey.json(), { error: 'missing key', code: 'UNAUTHORIZED' })

    const badKey = await GET(mkReq(`phoneHash=${HASH_A}`, 'ext-test-key-wrong-0000000000000000000000000000000000000000000000000000'))
    assert.equal(badKey.status, 401)
    assert.deepEqual(await badKey.json(), { error: 'invalid key', code: 'UNAUTHORIZED' })
  })

  it('scope 錯 → 403 FORBIDDEN（key 冇 patients scope）', async () => {
    const res = await GET(mkReq(`phoneHash=${HASH_A}`, KEY_NOSCOPE))
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.code, 'FORBIDDEN')
    assert.match(body.error, /scope patients not granted/)
  })

  it('audit：200 後有行、零 PII（path 唔含 query）', async () => {
    const res = await GET(mkReq(`phoneHash=${HASH_A}`, KEY_MAIN))
    assert.equal(res.status, 200)
    assert.ok(auditCreates.length >= 1)
    const row = auditCreates[auditCreates.length - 1]
    assert.deepEqual(Object.keys(row).sort(), ['keyName', 'latencyMs', 'path', 'status'])
    assert.equal(row.keyName, 'contract-key-main')
    assert.equal(row.path, '/api/external/v1/patient-lookup')
    assert.equal(row.status, 200)
    assert.ok(!String(row.path).includes('?'))
    assert.ok(!String(row.path).includes(HASH_A), 'audit 唔可以含 phoneHash（病人識別）')
  })
})
