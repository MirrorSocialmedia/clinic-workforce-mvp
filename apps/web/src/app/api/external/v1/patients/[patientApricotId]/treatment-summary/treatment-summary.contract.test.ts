/**
 * GET /api/external/v1/patients/{patientApricotId}/treatment-summary — contract test
 * （read-chain MD §4.3/§4.4）— cwc-rdchain-20260823-b1
 *
 * - fixture `test/fixtures/external-v1-treatment-summary.json`（MD sample 原樣）過 zod schema
 * - fixture sha256 錨定（交 wa-inbox 對同一 hash）
 * - route 200 形狀 = schema 同形 + 負面 PII 斷言（序列化唔含 PII key）
 * - 驗收：過去行倒序 cap 50／只計 bookingStatus ≥ 0（負數取消唔算到診）／
 *   未來行唔計／病人不存在 404 PATIENT_NOT_FOUND／零 visits → syncedAt null
 * - 401（缺/錯 key）／403（scope）／audit 行零 PII（path 用 :patientApricotId 佔位）
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from '../../../../../../../lib/prisma'
import { toHKDateStr, addDaysStr } from '../../../../../../../lib/hk-date'
import { GET } from './route'

type Any = any

// ── fixture 錨定 ─────────────────────────────────────────────────────
const FIXTURE_PATH = fileURLToPath(new URL('../../../../../../../../test/fixtures/external-v1-treatment-summary.json', import.meta.url))
const FIXTURE_SHA256 = '251ec0da2734b203037cb4ce4ee5b26bf1a5cb6d6dc4611cf3a91f8c4b43dc79'
const PII_PATTERNS = ['medicalHistory', 'personalIdentity', 'address', 'phoneNum']

// MD §4.3 200 形狀（zod — strict：多一個 key 就 fail）
const VisitSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clinicCode: z.string().min(1),
  providerName: z.string().min(1),
  visitReasons: z.array(z.string()),
  remarks: z.string().nullable(),
}).strict()
const TreatmentSummaryV1Schema = z.object({
  v: z.literal(1),
  patientCode: z.string().min(1),
  patientName: z.string().min(1),
  syncedAt: z.string().nullable(),
  visits: z.array(VisitSchema),
}).strict()

// ── 測試假 key（fixture 假值）────────────────────────────────────────
const KEY_MAIN = 'ext-test-key-main-0000000000000000000000000000000000000000000000000000'
const KEY_NOSCOPE = 'ext-test-key-noscope-0000000000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const KEY_ROWS = [
  { id: 'k-main', name: 'contract-key-main', keyHash: sha(KEY_MAIN), scopes: ['patients'], active: true, lastUsedAt: null },
  { id: 'k-noscope', name: 'contract-key-noscope', keyHash: sha(KEY_NOSCOPE), scopes: ['appointments'], active: true, lastUsedAt: null },
]

// ── fake prisma（日期相對於今日 — 測試永唔會因日期過時而壞）──────────
const TODAY = toHKDateStr(new Date())
let apptSyncedAt = new Date() // fresh（syncedAt 斷言用）— case 可手改

const PATIENT_ROWS: Any[] = [
  { patientApricotId: 'pt-1', patientCode: 'TKW001991', patientName: '陳大文' },
  { patientApricotId: 'pt-2', patientCode: 'TKW001992', patientName: '陳小明' },
]

// pt-1：55 過去行（i=1..55）— i=3 取消（-7，要排除）／i=7 完成（4，要計）；
// 另 1 未來行（+2，要排除）→ 合資格 54 行 → cap 50
const APPT_ROWS: Any[] = []
for (let i = 1; i <= 55; i++) {
  APPT_ROWS.push({
    patientApricotId: 'pt-1',
    date: addDaysStr(TODAY, -i),
    startTime: '10:00',
    clinicId: 'cl-tkw',
    providerName: 'Dr. Lau',
    visitReasons: ['FILLING'],
    remarks: i % 2 === 0 ? `備註 ${i}` : null,
    bookingStatus: i === 3 ? -7 : i === 7 ? 4 : 0,
  })
}
APPT_ROWS.push({
  patientApricotId: 'pt-1',
  date: addDaysStr(TODAY, +2),
  startTime: '10:00',
  clinicId: 'cl-tkw',
  providerName: 'Dr. Lau',
  visitReasons: ['RECALL'],
  remarks: null,
  bookingStatus: 0,
})

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
    findUnique: async (args: Any) =>
      PATIENT_ROWS.find(p => p.patientApricotId === args.where.patientApricotId) ?? null,
  },
  appointmentIndex: {
    findMany: async (args: Any) => {
      const rows = APPT_ROWS
        .filter(r => r.patientApricotId === args.where.patientApricotId)
        .filter(r => (args.where.date?.lte ? r.date <= args.where.date.lte : true))
        .filter(r => (typeof args.where.bookingStatus?.gte === 'number' ? r.bookingStatus >= args.where.bookingStatus.gte : true))
        .sort((a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime))
        .slice(0, args.take ?? Infinity)
        .map(({ bookingStatus, ...rest }) => ({ ...rest, syncedAt: apptSyncedAt }))
      return rows
    },
  },
  clinic: {
    findMany: async (args: Any) =>
      [{ id: 'cl-tkw', shortName: 'TKW' }].filter(c => args.where.id?.in?.includes(c.id) ?? false),
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
  apptSyncedAt = new Date()
})

function mkReq(patientApricotId: string, key?: string): { req: NextRequest; params: { patientApricotId: string } } {
  const headers: Record<string, string> = {}
  if (key) headers['x-api-key'] = key
  return {
    req: new NextRequest(`http://localhost:3000/api/external/v1/patients/${patientApricotId}/treatment-summary`, { headers }),
    params: { patientApricotId },
  }
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

  it('fixture 過 zod schema（MD §4.3 200 形狀）', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    const parsed = TreatmentSummaryV1Schema.safeParse(fixture)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
  })

  it('route 200 response 過 zod schema + 負面 PII 斷言', async () => {
    const { req, params } = mkReq('pt-1', KEY_MAIN)
    const res = await GET(req, { params })
    assert.equal(res.status, 200)
    const body = await res.json()
    const parsed = TreatmentSummaryV1Schema.safeParse(body)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
    assertNoPiiKeys(body)
  })
})

// ── §4.3 驗收（mock）─────────────────────────────────────────────────

describe('§4.3 — 驗收全項（mock）', () => {
  it('過去行倒序 + cap 50 + 只計 bookingStatus ≥ 0（取消單排除）', async () => {
    const { req, params } = mkReq('pt-1', KEY_MAIN)
    const res = await GET(req, { params })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.v, 1)
    assert.equal(body.patientCode, 'TKW001991')
    assert.equal(body.patientName, '陳大文')
    assert.ok(typeof body.syncedAt === 'string')

    // 合資格 = 55 過去行 - 1 取消（i=3）= 54；cap 50
    assert.equal(body.visits.length, 50)
    // 倒序：最新 = TODAY-1
    assert.equal(body.visits[0].date, addDaysStr(TODAY, -1))
    // 50 行 = i ∈ {1..51}\{3}（i=3 取消排除）→ 最後一行 = TODAY-51
    assert.equal(body.visits[49].date, addDaysStr(TODAY, -51))
    // 取消單（TODAY-3, status -7）唔喺內
    const cancelledDate = addDaysStr(TODAY, -3)
    assert.ok(!body.visits.some((v: Any) => v.date === cancelledDate), '取消單唔可以當治療史')
    // 未來行（TODAY+2）唔喺內
    const futureDate = addDaysStr(TODAY, +2)
    assert.ok(!body.visits.some((v: Any) => v.date === futureDate), '未來行唔係治療史')
    // 形狀抽查
    assert.equal(body.visits[0].clinicCode, 'TKW')
    assert.equal(body.visits[0].providerName, 'Dr. Lau')
    assert.deepEqual(body.visits[0].visitReasons, ['FILLING'])
  })

  it('病人唔喺 PatientIndex → 404 PATIENT_NOT_FOUND（照現有 code 形狀）', async () => {
    const { req, params } = mkReq('pt-404', KEY_MAIN)
    const res = await GET(req, { params })
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'patient not found', code: 'PATIENT_NOT_FOUND' })
  })

  it('喺 PatientIndex 但零合資格 visits → 200 空 visits + syncedAt null', async () => {
    const { req, params } = mkReq('pt-2', KEY_MAIN)
    const res = await GET(req, { params })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.visits, [])
    assert.equal(body.syncedAt, null)
    assertNoPiiKeys(body)
  })

  it('key 錯 → 401（缺 key / 錯 key）', async () => {
    const a = mkReq('pt-1')
    const noKey = await GET(a.req, { params: a.params })
    assert.equal(noKey.status, 401)
    assert.deepEqual(await noKey.json(), { error: 'missing key', code: 'UNAUTHORIZED' })

    const b = mkReq('pt-1', 'ext-test-key-wrong-0000000000000000000000000000000000000000000000000000')
    const badKey = await GET(b.req, { params: b.params })
    assert.equal(badKey.status, 401)
    assert.deepEqual(await badKey.json(), { error: 'invalid key', code: 'UNAUTHORIZED' })
  })

  it('scope 錯 → 403 FORBIDDEN（key 冇 patients scope）', async () => {
    const { req, params } = mkReq('pt-1', KEY_NOSCOPE)
    const res = await GET(req, { params })
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.code, 'FORBIDDEN')
    assert.match(body.error, /scope patients not granted/)
  })

  it('audit：path 用 :patientApricotId 佔位（唔寫真實 apricot id）+ 零 PII', async () => {
    const { req, params } = mkReq('pt-1', KEY_MAIN)
    const res = await GET(req, { params })
    assert.equal(res.status, 200)
    assert.ok(auditCreates.length >= 1)
    const row = auditCreates[auditCreates.length - 1]
    assert.deepEqual(Object.keys(row).sort(), ['keyName', 'latencyMs', 'path', 'status'])
    assert.equal(row.keyName, 'contract-key-main')
    assert.equal(row.path, '/api/external/v1/patients/:patientApricotId/treatment-summary')
    assert.equal(row.status, 200)
    assert.ok(!String(row.path).includes('pt-1'), 'audit 唔可以含真實 patientApricotId')
  })
})
