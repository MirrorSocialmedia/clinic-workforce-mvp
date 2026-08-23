/**
 * GET /api/external/v1/appointments — contract test（read-chain MD §4.2/§4.4）
 * cwc-rdchain-20260823-b1
 *
 * - fixture `test/fixtures/external-v1-appointments.json`（MD sample 原樣）過 zod schema
 * - fixture sha256 錨定（交 wa-inbox 對同一 hash）
 * - route 200 形狀 = schema 同形 + 負面 PII 斷言（序列化唔含 PII key）
 * - 驗收：phoneHash/from/to 必填／範圍 ≤ 38 日（consumer -7→+30 整 38 日 OK；39 日 400）／
 *   stale 同 availability 同一規則（syncedAt > 30 分鐘）
 * - 401（缺/錯 key）／403（scope）／429（狂打）／audit 行零 PII
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
const FIXTURE_PATH = fileURLToPath(new URL('../../../../../../test/fixtures/external-v1-appointments.json', import.meta.url))
const FIXTURE_SHA256 = '181ec2e50afad59a2619d46f286ef301e7f39bd912bf2d37bd862212c29a8ea0'
const PII_PATTERNS = ['medicalHistory', 'personalIdentity', 'address', 'phoneNum']

// MD §4.2 200 形狀（zod — strict：多一個 key 就 fail）
const AppointmentSchema = z.object({
  apricotApptId: z.string().min(1),
  clinicCode: z.string().min(1),
  providerApricotId: z.string().min(1),
  providerName: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  bookingStatus: z.number().int(),
  patientApricotId: z.string().min(1),
  patientCode: z.string().min(1),
  patientName: z.string().min(1),
  visitReasons: z.array(z.string()),
  remarks: z.string().nullable(),
}).strict()
const AppointmentsV1Schema = z.object({
  v: z.literal(1),
  syncedAt: z.string().nullable(),
  stale: z.boolean(),
  appointments: z.array(AppointmentSchema),
}).strict()

// ── 測試假 key（fixture 假值）────────────────────────────────────────
const KEY_MAIN = 'ext-test-key-main-0000000000000000000000000000000000000000000000000000'
const KEY_NOSCOPE = 'ext-test-key-noscope-0000000000000000000000000000000000000000000000000'
const KEY_BURST = 'ext-test-key-burst-0000000000000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const KEY_ROWS = [
  { id: 'k-main', name: 'contract-key-main', keyHash: sha(KEY_MAIN), scopes: ['appointments', 'patients'], active: true, lastUsedAt: null },
  { id: 'k-noscope', name: 'contract-key-noscope', keyHash: sha(KEY_NOSCOPE), scopes: ['availability'], active: true, lastUsedAt: null },
  { id: 'k-burst', name: 'contract-key-burst', keyHash: sha(KEY_BURST), scopes: ['appointments'], active: true, lastUsedAt: null },
]

// ── fake prisma（日期相對於今日 — 測試永唔會因日期過時而壞）──────────
const TODAY = toHKDateStr(new Date())
const HASH_A = 'a'.repeat(64)
const HASH_C = 'c'.repeat(64)
let apptSyncedAt = new Date() // fresh（stale=false 預設）— stale case 手改

const APPT_ROWS: Any[] = [
  { apricotApptId: 'ap-1', clinicId: 'cl-tkw', providerApricotId: 'prov-lau', providerName: 'Dr. Lau', date: addDaysStr(TODAY, -3), startTime: '10:00', endTime: '10:30', bookingStatus: 4, patientApricotId: 'pt-1', patientCode: 'TKW001991', patientName: '陳大文', phoneHash: HASH_A, visitReasons: ['FILLING'], remarks: '覆診跟進' },
  { apricotApptId: 'ap-2', clinicId: 'cl-tkw', providerApricotId: 'prov-lau', providerName: 'Dr. Lau', date: addDaysStr(TODAY, -3), startTime: '14:30', endTime: '15:00', bookingStatus: -7, patientApricotId: 'pt-1', patientCode: 'TKW001991', patientName: '陳大文', phoneHash: HASH_A, visitReasons: ['RECALL'], remarks: null },
  { apricotApptId: 'ap-3', clinicId: 'cl-tkw', providerApricotId: 'prov-lau', providerName: 'Dr. Lau', date: addDaysStr(TODAY, +5), startTime: '09:00', endTime: '09:30', bookingStatus: 0, patientApricotId: 'pt-1', patientCode: 'TKW001991', patientName: '陳大文', phoneHash: HASH_A, visitReasons: ['IMPLANT IMPRESSION'], remarks: '新約' },
  { apricotApptId: 'ap-4', clinicId: 'cl-tkw', providerApricotId: 'prov-tong', providerName: 'Dr. Tong', date: addDaysStr(TODAY, +20), startTime: '11:00', endTime: '11:30', bookingStatus: 0, patientApricotId: 'pt-1', patientCode: 'TKW001991', patientName: '陳大文', phoneHash: HASH_A, visitReasons: [], remarks: null },
  // 另一個 phoneHash — 必須被排除
  { apricotApptId: 'ap-5', clinicId: 'cl-tkw', providerApricotId: 'prov-lau', providerName: 'Dr. Lau', date: addDaysStr(TODAY, +5), startTime: '09:00', endTime: '09:30', bookingStatus: 0, patientApricotId: 'pt-9', patientCode: 'TKW009999', patientName: '李四', phoneHash: HASH_C, visitReasons: [], remarks: null },
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
  appointmentIndex: {
    findMany: async (args: Any) =>
      APPT_ROWS
        .filter(r => r.phoneHash === args.where.phoneHash)
        .filter(r => (args.where.date?.gte ? r.date >= args.where.date.gte : true))
        .filter(r => (args.where.date?.lte ? r.date <= args.where.date.lte : true))
        .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
        .map(({ phoneHash, ...rest }) => ({ ...rest, syncedAt: apptSyncedAt })),
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

function mkReq(query: string, key?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (key) headers['x-api-key'] = key
  return new NextRequest(`http://localhost:3000/api/external/v1/appointments?${query}`, { headers })
}

function assertNoPiiKeys(body: unknown): void {
  const raw = JSON.stringify(body)
  for (const p of PII_PATTERNS) {
    assert.ok(!raw.includes(p), `response 含 PII key：${p}`)
  }
}

// §4.2：consumer 標準窗 = -7 → +30（38 個日曆日，to - from = 37）
const WIN_FROM = addDaysStr(TODAY, -7)
const WIN_TO = addDaysStr(TODAY, +30)

// ── contract ─────────────────────────────────────────────────────────

describe('§4.4 — fixture + zod schema 契約', () => {
  it('fixture 檔存在 + sha256 錨定（wa-inbox 對照用）', () => {
    const raw = readFileSync(FIXTURE_PATH)
    const actual = createHash('sha256').update(raw).digest('hex')
    assert.equal(actual, FIXTURE_SHA256, 'fixture sha256 漂移 — 改咗 MD sample 要重新對')
  })

  it('fixture 過 zod schema（MD §4.2 200 形狀）', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    const parsed = AppointmentsV1Schema.safeParse(fixture)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
  })

  it('route 200 response 過 zod schema + 負面 PII 斷言', async () => {
    const res = await GET(mkReq(`phoneHash=${HASH_A}&from=${WIN_FROM}&to=${WIN_TO}`, KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    const parsed = AppointmentsV1Schema.safeParse(body)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
    assertNoPiiKeys(body)
  })
})

// ── §4.2 驗收（mock）─────────────────────────────────────────────────

describe('§4.2 — 驗收全項（mock）', () => {
  it('200：consumer 標準窗 -7→+30（整 38 日）— 全欄形狀 + 排序 + clinicCode', async () => {
    const res = await GET(mkReq(`phoneHash=${HASH_A}&from=${WIN_FROM}&to=${WIN_TO}`, KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.v, 1)
    assert.equal(body.stale, false)
    assert.ok(typeof body.syncedAt === 'string')
    // 4 單（ap-5 另一 phoneHash 排除）；date asc → startTime asc
    assert.deepEqual(body.appointments.map((a: Any) => a.apricotApptId), ['ap-1', 'ap-2', 'ap-3', 'ap-4'])
    const first = body.appointments[0]
    assert.equal(first.clinicCode, 'TKW')
    assert.equal(first.date, addDaysStr(TODAY, -3))
    assert.equal(first.start, '10:00')
    assert.equal(first.end, '10:30')
    assert.equal(first.bookingStatus, 4)
    assert.equal(first.patientCode, 'TKW001991')
    assert.deepEqual(first.visitReasons, ['FILLING'])
    assert.equal(first.remarks, '覆診跟進')
    // 取消單（-7）原樣回傳 — 本 API 係完整預約記錄（過濾只喺 treatment-summary）
    assert.equal(body.appointments[1].bookingStatus, -7)
    assert.equal(body.appointments[1].remarks, null)
  })

  it('400：必填/格式/範圍錯各款（範圍 ≤ 38 日）', async () => {
    const cases = [
      `from=${WIN_FROM}&to=${WIN_TO}`, // 缺 phoneHash
      `phoneHash=${HASH_A}&to=${WIN_TO}`, // 缺 from
      `phoneHash=${HASH_A}&from=${WIN_FROM}`, // 缺 to
      `phoneHash=abc&from=${WIN_FROM}&to=${WIN_TO}`, // phoneHash 格式錯
      `phoneHash=${HASH_A}&from=${WIN_FROM.replaceAll('-', '/')}&to=${WIN_TO}`, // 格式錯（YYYY/MM/DD）
      `phoneHash=${HASH_A}&from=2026-02-30&to=${WIN_TO}`, // 偽日期
      `phoneHash=${HASH_A}&from=${WIN_TO}&to=${WIN_FROM}`, // to < from
      `phoneHash=${HASH_A}&from=${addDaysStr(TODAY, -8)}&to=${addDaysStr(TODAY, +30)}`, // 39 日（diff 38）> 38
    ]
    for (const q of cases) {
      const res = await GET(mkReq(q, KEY_MAIN))
      assert.equal(res.status, 400, `應該 400：${q}`)
      const body = await res.json()
      assert.equal(body.code, 'BAD_REQUEST')
    }
    // 恰好 38 日（diff 37）OK
    const ok38 = await GET(mkReq(`phoneHash=${HASH_A}&from=${WIN_FROM}&to=${WIN_TO}`, KEY_MAIN))
    assert.equal(ok38.status, 200)
    // 39 日明確訊息
    const over = await GET(mkReq(`phoneHash=${HASH_A}&from=${addDaysStr(TODAY, -8)}&to=${addDaysStr(TODAY, +30)}`, KEY_MAIN))
    assert.equal(over.status, 400)
    assert.match((await over.json()).error, /38 days/)
  })

  it('stale：syncedAt 舊過 30 分鐘 → stale:true（手改 syncedAt）', async () => {
    apptSyncedAt = new Date(Date.now() - 31 * 60 * 1000)
    const res = await GET(mkReq(`phoneHash=${HASH_A}&from=${WIN_FROM}&to=${WIN_TO}`, KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.stale, true)
    assert.equal(body.syncedAt, apptSyncedAt.toISOString())
  })

  it('stale：無數據（零行）→ stale:true + syncedAt null', async () => {
    const HASH_NONE = 'e'.repeat(64)
    const res = await GET(mkReq(`phoneHash=${HASH_NONE}&from=${WIN_FROM}&to=${WIN_TO}`, KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.appointments, [])
    assert.equal(body.stale, true)
    assert.equal(body.syncedAt, null)
  })

  it('key 錯 → 401（缺 key / 錯 key）', async () => {
    const noKey = await GET(mkReq(`phoneHash=${HASH_A}&from=${WIN_FROM}&to=${WIN_TO}`))
    assert.equal(noKey.status, 401)
    assert.deepEqual(await noKey.json(), { error: 'missing key', code: 'UNAUTHORIZED' })

    const badKey = await GET(mkReq(`phoneHash=${HASH_A}&from=${WIN_FROM}&to=${WIN_TO}`, 'ext-test-key-wrong-0000000000000000000000000000000000000000000000000000'))
    assert.equal(badKey.status, 401)
    assert.deepEqual(await badKey.json(), { error: 'invalid key', code: 'UNAUTHORIZED' })
  })

  it('scope 錯 → 403 FORBIDDEN（key 冇 appointments scope）', async () => {
    const res = await GET(mkReq(`phoneHash=${HASH_A}&from=${WIN_FROM}&to=${WIN_TO}`, KEY_NOSCOPE))
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.code, 'FORBIDDEN')
    assert.match(body.error, /scope appointments not granted/)
  })

  it('狂打 → 429 RATE_LIMITED（token bucket 60 burst）', async () => {
    let statusCounts: Record<number, number> = {}
    for (let i = 0; i < 61; i++) {
      const res = await GET(mkReq(`phoneHash=${HASH_A}&from=${WIN_FROM}&to=${WIN_TO}`, KEY_BURST))
      statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1
    }
    assert.equal(statusCounts[200], 60)
    assert.equal(statusCounts[429], 1)
  })

  it('audit：200 後有行、零 PII（path 唔含 query / phoneHash）', async () => {
    const res = await GET(mkReq(`phoneHash=${HASH_A}&from=${WIN_FROM}&to=${WIN_TO}`, KEY_MAIN))
    assert.equal(res.status, 200)
    assert.ok(auditCreates.length >= 1)
    const row = auditCreates[auditCreates.length - 1]
    assert.deepEqual(Object.keys(row).sort(), ['keyName', 'latencyMs', 'path', 'status'])
    assert.equal(row.keyName, 'contract-key-main')
    assert.equal(row.path, '/api/external/v1/appointments')
    assert.equal(row.status, 200)
    assert.equal(typeof row.latencyMs, 'number')
    assert.ok(!String(row.path).includes('?'))
    assert.ok(!String(row.path).includes(HASH_A), 'audit 唔可以含 phoneHash（病人識別）')
  })
})
