/**
 * GET/POST /v1/bookable-slots + claim/commit/release + held
 * — contract test（mock 版）— providerslot-20260830 T1
 *
 * 全 mock：fake prisma（monkey-patch prisma + basePrisma）+ APRICOT_WRITE=0
 * （本地實測路徑：claim 必留 HELD — 驗收 gate 指定）。
 * 覆蓋（MD 3.1/3.2/3.3 + PII 鐵律）：
 *   - GET 200 形狀 zod strict + slotKey 可驗證 + 碎片零入 payload
 *   - window clamp（flowWindowDays=30）+ from<today 400 + unitMin≠30 400
 *   - claim 201（HELD）+ zod strict + PII 零回顯負面斷言
 *   - 冪等重放（同 flowToken → 同 holdId）
 *   - 409 slot_taken + alternatives（同醫生最近位）
 *   - 409 flow_token_reused（同 token 唔同 slot）
 *   - 400（slotKey 偽造 / Idempotency-Key 唔等於 flowToken / source 唔喺集）
 *   - commit（HELD→IN_APRICOT；冪等；RELEASED→409）
 *   - release（→RELEASED；apricotRef 透傳）
 *   - held（PII-free 形狀 + appointmentPast/ageHours）
 *   - 401/403/429（§A.2 守門）
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from '../../../../../lib/prisma'
import { verifySlotKey } from '../../../../../lib/bookable-slot-key'
import { todayHK, addDaysStr } from '../../../../../lib/hk-date'
import { GET } from './route'
import { POST as claimPOST } from './claim/route'
import * as commitRoute from './claim/[holdId]/commit/route'
import * as releaseRoute from './claim/[holdId]/route'
import { GET as heldGET } from './held/route'

type Any = any

// ── 時間 ─────────────────────────────────────────────────────────────
const D0 = addDaysStr(todayHK(), 1) // 明日 — 無 leadTime 約束（deterministic）
const D1 = addDaysStr(todayHK(), 2)

// ── 測試假 key ───────────────────────────────────────────────────────
const KEY_MAIN = 'ext-test-bs-main-000000000000000000000000000000000000000000000000000000'
const KEY_NOSCOPE = 'ext-test-bs-noscope-000000000000000000000000000000000000000000000000'
const KEY_BURST = 'ext-test-bs-burst-000000000000000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const KEY_ROWS = [
  { id: 'k-bs-main', name: 'contract-bs-main', keyHash: sha(KEY_MAIN), scopes: ['bookable-slots'], active: true, lastUsedAt: null },
  { id: 'k-bs-noscope', name: 'contract-bs-noscope', keyHash: sha(KEY_NOSCOPE), scopes: ['availability'], active: true, lastUsedAt: null },
  { id: 'k-bs-burst', name: 'contract-bs-burst', keyHash: sha(KEY_BURST), scopes: ['bookable-slots'], active: true, lastUsedAt: null },
]

// ── fake 狀態 ────────────────────────────────────────────────────────
const heldRows: Any[] = []
const auditCreates: Any[] = []
const auditMany: Any[] = []
let holdSeq = 0

const CLINIC = {
  id: 'cl-tkw',
  shortName: 'TKW',
  apricotClinicId: 'apr-clinic-1',
  capacityPerProvider: 3,
  leadTimeMin: 30,
  flowWindowDays: 30,
  holdTimeoutHours: 24,
}
const PROVIDER = { id: 'p-ho', name: 'Dr. Ho', apricotId: 'prov-ho' }

const fakes: Any = {
  externalApiKey: {
    findMany: async () => KEY_ROWS,
    update: async () => ({}),
  },
  externalApiAudit: {
    create: async (args: Any) => { auditCreates.push(args.data); return {} },
  },
  clinic: {
    findFirst: async () => ({ id: CLINIC.id, shortName: CLINIC.shortName, apricotClinicId: CLINIC.apricotClinicId }),
    findUnique: async () => CLINIC,
  },
  providerClinic: {
    findMany: async () => [{ providerId: PROVIDER.id }],
    findFirst: async () => ({ id: 'link-1' }),
  },
  provider: {
    findMany: async ({ where }: Any) => (where?.id ? [PROVIDER] : [{ ...PROVIDER }]),
    findUnique: async () => ({ ...PROVIDER }),
  },
  providerWeeklyPattern: { findMany: async () => [] },
  providerShift: { findMany: async () => [] },
  providerLeave: { findMany: async () => [] },
  providerAvailability: {
    // 只 D0 有 openSch（09:00–18:00）→ 精確軌；其他日 0 數據
    findMany: async () => [{ providerId: PROVIDER.id, date: D0, startTime: '09:00', endTime: '18:00' }],
  },
  providerBooking: {
    // D0 09:30–10:00 一筆預約 → 該窗 seatsFree=2
    findMany: async () => [{ providerId: PROVIDER.id, date: D0, startMin: 570, endMin: 600 }],
  },
  providerHold: {
    findMany: async ({ where }: Any) => {
      // sweep 形態（status HELD + OR）→ 無過期 hold
      if (where.status === 'HELD' && where.OR) return []
      // claim tx 重算 / GET 載入 形態（有 providerId/date 條件）
      if (where.providerId) {
        return heldRows.filter(
          (r) => r.providerId === where.providerId && r.date === where.date && (where.status?.in ?? []).includes(r.status),
        ).map((r) => ({ startMin: r.startMin, endMin: r.endMin }))
      }
      // held list 形態（status.in / equals）
      if (where.status?.in) return heldRows.filter((r) => where.status.in.includes(r.status))
      if (where.status?.equals) return heldRows.filter((r) => r.status === where.status.equals)
      if (typeof where.status === 'string') return heldRows.filter((r) => r.status === where.status)
      return heldRows
    },
    findUnique: async ({ where }: Any) => {
      if (where.flowToken) return heldRows.find((r) => r.flowToken === where.flowToken) ?? null
      if (where.id) return heldRows.find((r) => r.id === where.id) ?? null
      return null
    },
    create: async ({ data }: Any) => {
      holdSeq += 1
      const row = {
        id: `hold-c${String(holdSeq).padStart(3, '0')}`,
        createdAt: new Date(),
        committedAt: null,
        apricotRef: null,
        ...data,
      }
      heldRows.push(row)
      return { id: row.id, date: row.date, startMin: row.startMin, endMin: row.endMin, providerId: row.providerId }
    },
    update: async ({ where, data }: Any) => {
      const row = heldRows.find((r) => r.id === where.id)
      if (row) Object.assign(row, data)
      return row ?? {}
    },
    updateMany: async () => ({ count: 0 }),
  },
  availabilityCache: { findMany: async () => [] },
  auditLog: {
    create: async (args: Any) => { auditCreates.push({ ...args.data, __entity: args.data.entity }); return {} },
    createMany: async (args: Any) => { auditMany.push(args.data); return { count: args.data.length } },
  },
  $transaction: async (arg: Any) => (Array.isArray(arg) ? Promise.all(arg) : arg(fakes)),
}

let saved: [Any, string, Any][] = []
const envSaved: string[] = []
before(() => {
  envSaved.push(process.env.APRICOT_WRITE ?? '', process.env.ALLOW_NEW_PATIENT_WRITE ?? '', process.env.BOOKABLE_SLOT_HMAC_SECRET ?? '')
  // 本地實測路徑（驗收 gate 指定）：APRICOT_WRITE=0 → claim 必留 HELD
  process.env.APRICOT_WRITE = '0'
  delete process.env.ALLOW_NEW_PATIENT_WRITE
  process.env.BOOKABLE_SLOT_HMAC_SECRET = 'test-hmac-secret-bookable-slots'
  for (const obj of [prisma, basePrisma]) {
    for (const k of Object.keys(fakes)) {
      saved.push([obj, k, (obj as Any)[k]])
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
  }
})
after(() => {
  ;(process.env as Any).APRICOT_WRITE = envSaved[0]
  if (envSaved[1]) process.env.ALLOW_NEW_PATIENT_WRITE = envSaved[1]
  if (envSaved[2]) process.env.BOOKABLE_SLOT_HMAC_SECRET = envSaved[2]
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
})
beforeEach(() => {
  heldRows.length = 0
  auditCreates.length = 0
  auditMany.length = 0
  holdSeq = 0
})

// ── request 助手 ─────────────────────────────────────────────────────
const BASE = 'http://localhost:3000/api/external/v1/bookable-slots'
function mkReq(method: string, url: string, opts: { key?: string; body?: Any; headers?: Record<string, string> } = {}): NextRequest {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.key) headers['x-api-key'] = opts.key
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  return new NextRequest(url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined })
}
const PII_PATTERNS = ['85212345678', '測試病人甲', 'patientWaId', 'patientName', 'waId', 'medicalHistory']
function assertZeroPii(body: Any, label: string) {
  const raw = JSON.stringify(body)
  for (const p of PII_PATTERNS) {
    assert.ok(!raw.includes(p), `${label} response 含 PII/病人欄: ${p}`)
  }
}

// ── zod 契約（MD 3.1/3.2 形狀）────────────────────────────────────────
const SlotSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  providerId: z.string().min(1),
  providerName: z.string(),
  seatsFree: z.number().int().min(1).max(3),
  remainingCapacity: z.number().int().min(1).max(3),
  slotKey: z.string().min(8),
}).strict()
const DaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  closed: z.boolean(),
  offerableCount: z.number().int().min(0),
  slots: z.array(SlotSchema),
}).strict()
const GetV1Schema = z.object({
  v: z.literal(1),
  unitMin: z.literal(30),
  capacityPerProvider: z.number().int().min(1),
  leadTimeMin: z.number().int().min(0),
  generatedAt: z.string(),
  days: z.array(DaySchema),
}).strict()
const ClaimV1Schema = z.object({
  v: z.literal(1),
  holdId: z.string().min(8),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providerName: z.string(),
  expiresAt: z.null(),
}).strict()
const HeldRowSchema = z.object({
  holdId: z.string().min(8),
  date: z.string(),
  startMin: z.number().int(),
  endMin: z.number().int(),
  providerId: z.string(),
  providerName: z.string(),
  status: z.enum(['HELD', 'IN_APRICOT']),
  source: z.string(),
  createdAt: z.string(),
  ageHours: z.number().min(0),
  appointmentPast: z.boolean(),
}).strict()

// ── GET /v1/bookable-slots ───────────────────────────────────────────

describe('GET /v1/bookable-slots — 200 契約（MD 3.1）', () => {
  it('200 形狀過 zod strict + slotKey 可驗證 + 碎片零入 payload', async () => {
    const res = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${D0}&to=${D0}`, { key: KEY_MAIN }))
    assert.equal(res.status, 200)
    const body = await res.json()
    const parsed = GetV1Schema.safeParse(body)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
    assert.equal(body.capacityPerProvider, 3)
    assert.equal(body.leadTimeMin, 30)

    const day = body.days[0]
    assert.equal(day.date, D0)
    assert.equal(day.closed, false)
    // 09:00–18:00 openSch → 18 個 30m 窗（09:00..17:30）
    assert.equal(day.offerableCount, 18)
    assert.equal(day.slots.length, 18)
    // 09:30 窗有 1 筆預約 → seatsFree=2；10:00 窗空 → 3
    const s0930 = day.slots.find((s: Any) => s.start === '09:30')
    const s1000 = day.slots.find((s: Any) => s.start === '10:00')
    assert.equal(s0930.seatsFree, 2)
    assert.equal(s1000.seatsFree, 3)
    // B7（F2）：remainingCapacity = capacity − booked（問診+覆診共享池）；同 seatsFree
    assert.equal(s0930.remainingCapacity, 2)
    assert.equal(s1000.remainingCapacity, 3)
    for (const s of day.slots) assert.equal(s.remainingCapacity, s.seatsFree)
    // slotKey 可驗證 + 載體正確（唔准 client 自己拼）
    const parts = verifySlotKey(s1000.slotKey)
    assert.ok(parts, 'slotKey 應該可驗證')
    assert.equal(parts.clinicCode, 'TKW')
    assert.equal(parts.date, D0)
    assert.equal(parts.start, '10:00')
    assert.equal(parts.providerId, PROVIDER.id)
    assert.equal(parts.unitMin, 30)
    // 偽 slotKey 唔可以過（防偽造）
    const tampered = s1000.slotKey.slice(0, -4) + 'aaaa'
    assert.equal(verifySlotKey(tampered), null)
    assertZeroPii(body, 'GET')
  })

  it('無數據日（未 sync）：closed=false + 0 slots（唔假閉門）', async () => {
    const res = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${D1}&to=${D1}`, { key: KEY_MAIN }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.days[0].closed, false)
    assert.equal(body.days[0].offerableCount, 0)
    assert.deepEqual(body.days[0].slots, [])
  })

  it('window clamp：to 超 flowWindowDays=30 → 30 日', async () => {
    const res = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${D0}&to=${addDaysStr(todayHK(), 60)}`, { key: KEY_MAIN }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.days.length, 30)
  })

  it('400：from<today / to<from / unitMin≠30 / 缺 clinicCode', async () => {
    const past = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${addDaysStr(todayHK(), -1)}&to=${D0}`, { key: KEY_MAIN }))
    assert.equal(past.status, 400)
    const rev = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${D1}&to=${D0}`, { key: KEY_MAIN }))
    assert.equal(rev.status, 400)
    const unit = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${D0}&to=${D0}&unitMin=15`, { key: KEY_MAIN }))
    assert.equal(unit.status, 400)
    const noClinic = await GET(mkReq('GET', `${BASE}?from=${D0}&to=${D0}`, { key: KEY_MAIN }))
    assert.equal(noClinic.status, 400)
  })
})

// ── POST /v1/bookable-slots/claim（MD 3.2）───────────────────────────

async function fetchSlotKey(start: string): Promise<string> {
  const res = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${D0}&to=${D0}`, { key: KEY_MAIN }))
  const body = await res.json()
  const slot = body.days[0].slots.find((s: Any) => s.start === start)
  assert.ok(slot, `slot ${start} 應該存在`)
  return slot.slotKey
}

function claimBody(over: Any = {}): Any {
  return {
    v: 1,
    slotKey: 'placeholder',
    patient: { waId: '85212345678', name: '測試病人甲' },
    source: 'whatsapp_flow',
    flowToken: 'flow-tok-0001',
    ...over,
  }
}

describe('POST /v1/bookable-slots/claim — 201（APRICOT_WRITE=0 → HELD）', () => {
  it('201 形狀過 zod strict + PII 零回顯 + audit 零 PII', async () => {
    const slotKey = await fetchSlotKey('10:00')
    const body = claimBody({ slotKey })
    const res = await claimPOST(mkReq('POST', `${BASE}/claim`, {
      key: KEY_MAIN, body, headers: { 'idempotency-key': body.flowToken },
    }))
    assert.equal(res.status, 201)
    const json = await res.json()
    const parsed = ClaimV1Schema.safeParse(json)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
    assert.equal(json.start, '10:00')
    assert.equal(json.end, '10:30')
    assert.equal(json.date, D0)
    assert.equal(json.providerName, 'Dr. Ho')
    assertZeroPii(json, 'claim 201')

    // DB 行：HELD + PII 只喺内部（fake 層核）
    const row = heldRows[0]
    assert.equal(row.status, 'HELD') // APRICOT_WRITE=0 → 唔寫 Apricot
    assert.equal(row.patientWaId, '85212345678')
    assert.equal(row.patientName, '測試病人甲')
    assert.equal(row.startMin, 600)
    assert.equal(row.endMin, 630)
    assert.equal(row.flowToken, 'flow-tok-0001')

    // audit（PROVIDER_HOLD_CLAIM）— notes 零 PII
    const claimAudits = auditCreates.filter((a) => a.action === 'PROVIDER_HOLD_CLAIM')
    assert.equal(claimAudits.length, 1)
    assert.ok(!JSON.stringify(claimAudits[0].notes).includes('85212345678'))
    assert.ok(!JSON.stringify(claimAudits[0].notes).includes('測試病人甲'))
  })

  it('冪等重放：同 flowToken → 同 holdId（201）', async () => {
    const slotKey = await fetchSlotKey('10:00')
    const body = claimBody({ slotKey })
    const r1 = await claimPOST(mkReq('POST', `${BASE}/claim`, { key: KEY_MAIN, body, headers: { 'idempotency-key': body.flowToken } }))
    assert.equal(r1.status, 201)
    const j1 = await r1.json()
    const r2 = await claimPOST(mkReq('POST', `${BASE}/claim`, { key: KEY_MAIN, body, headers: { 'idempotency-key': body.flowToken } }))
    assert.equal(r2.status, 201)
    const j2 = await r2.json()
    assert.equal(j2.holdId, j1.holdId)
    assert.equal(heldRows.length, 1) // 唔佔兩個位
  })

  it('409 slot_taken + alternatives（同醫生最近位 ≥ 被搶位）', async () => {
    // 先攞 10:30 slotKey（client 早先 GET 攞到）→ 先塞 hold → 再 claim
    const slotKey = await fetchSlotKey('10:30')
    heldRows.push({
      id: 'hold-seed-1', clinicId: CLINIC.id, providerId: PROVIDER.id, date: D0,
      startMin: 630, endMin: 660, status: 'HELD', flowToken: 'flow-seed-0001',
      patientWaId: '85200000000', patientName: '種子病人', source: 'staff',
      createdAt: new Date(), committedAt: null, apricotRef: null,
    })
    const body = claimBody({ slotKey, flowToken: 'flow-tok-0002' })
    const res = await claimPOST(mkReq('POST', `${BASE}/claim`, { key: KEY_MAIN, body, headers: { 'idempotency-key': body.flowToken } }))
    assert.equal(res.status, 409)
    const json = await res.json()
    assert.equal(json.error, 'slot_taken')
    assert.ok(Array.isArray(json.alternatives) && json.alternatives.length >= 2, 'alternatives 應該 2-3 個')
    // 同醫生最近位：10:30 已佔 → 首個應該係 11:00
    assert.equal(json.alternatives[0].start, '11:00')
    assert.equal(json.alternatives[0].providerId, PROVIDER.id)
    // 新 hold 冇入
    assert.equal(heldRows.length, 1)
    assertZeroPii(json, 'claim 409')
  })

  it('409 flow_token_reused（同 token 唔同 slot）', async () => {
    heldRows.push({
      id: 'hold-seed-2', clinicId: CLINIC.id, providerId: PROVIDER.id, date: D0,
      startMin: 600, endMin: 630, status: 'HELD', flowToken: 'flow-tok-reuse',
      patientWaId: '85200000000', patientName: '種子病人', source: 'staff',
      createdAt: new Date(), committedAt: null, apricotRef: null,
    })
    const slotKey = await fetchSlotKey('11:00') // 唔同 slot
    const body = claimBody({ slotKey, flowToken: 'flow-tok-reuse' })
    const res = await claimPOST(mkReq('POST', `${BASE}/claim`, { key: KEY_MAIN, body, headers: { 'idempotency-key': body.flowToken } }))
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, 'FLOW_TOKEN_REUSED')
  })

  it('400：偽造 slotKey / Idempotency-Key 唔等 / source 唔喺集 / v≠1 / 缺 patient', async () => {
    const forged = await claimPOST(mkReq('POST', `${BASE}/claim`, {
      key: KEY_MAIN, body: claimBody({ slotKey: 'Zm9yZ2VkLmtleQ.aaaa' }), headers: { 'idempotency-key': 'flow-tok-0001' },
    }))
    assert.equal(forged.status, 400)

    const slotKey = await fetchSlotKey('10:00')
    const mismatch = await claimPOST(mkReq('POST', `${BASE}/claim`, {
      key: KEY_MAIN, body: claimBody({ slotKey }), headers: { 'idempotency-key': 'flow-tok-DIFFERENT' },
    }))
    assert.equal(mismatch.status, 400)

    const badSource = await claimPOST(mkReq('POST', `${BASE}/claim`, {
      key: KEY_MAIN, body: claimBody({ slotKey, source: 'evil' }), headers: { 'idempotency-key': 'flow-tok-0001' },
    }))
    assert.equal(badSource.status, 400)

    const badV = await claimPOST(mkReq('POST', `${BASE}/claim`, {
      key: KEY_MAIN, body: { ...claimBody({ slotKey }), v: 2 }, headers: { 'idempotency-key': 'flow-tok-0001' },
    }))
    assert.equal(badV.status, 400)

    const noPatient = await claimPOST(mkReq('POST', `${BASE}/claim`, {
      key: KEY_MAIN, body: { v: 1, slotKey, source: 'staff', flowToken: 'flow-tok-0001' }, headers: { 'idempotency-key': 'flow-tok-0001' },
    }))
    assert.equal(noPatient.status, 400)
  })
})

// ── commit / release（MD 3.3）────────────────────────────────────────

async function seedHold(status: string, startMin = 600): Promise<Any> {
  heldRows.push({
    id: 'hold-cr-001', clinicId: CLINIC.id, providerId: PROVIDER.id, date: D0,
    startMin, endMin: startMin + 30, status, flowToken: 'flow-cr-0001',
    patientWaId: '85200000000', patientName: '種子病人', source: 'staff',
    createdAt: new Date(), committedAt: null, apricotRef: status === 'IN_APRICOT' ? 'apr-apt-9' : null,
  })
  return heldRows[heldRows.length - 1]
}

describe('POST /v1/bookable-slots/claim/{holdId}/commit', () => {
  it('HELD → IN_APRICOT（200 + committedAt）+ audit 零 PII', async () => {
    await seedHold('HELD')
    const res = await commitRoute.POST(mkReq('POST', `${BASE}/claim/hold-cr-001/commit`, { key: KEY_MAIN, body: {} }), { params: { holdId: 'hold-cr-001' } })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.status, 'IN_APRICOT')
    assert.ok(json.committedAt)
    assert.equal(heldRows[0].status, 'IN_APRICOT')
    const a = auditCreates.find((x) => x.action === 'PROVIDER_HOLD_COMMIT')
    assert.ok(a, 'commit audit 應該有')
    assertZeroPii(json, 'commit')
  })

  it('冪等：已 IN_APRICOT → 200 同狀', async () => {
    await seedHold('IN_APRICOT')
    const res = await commitRoute.POST(mkReq('POST', `${BASE}/claim/hold-cr-001/commit`, { key: KEY_MAIN, body: {} }), { params: { holdId: 'hold-cr-001' } })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).status, 'IN_APRICOT')
  })

  it('RELEASED → 409 HOLD_RELEASED；不存在 → 404', async () => {
    await seedHold('RELEASED')
    const res = await commitRoute.POST(mkReq('POST', `${BASE}/claim/hold-cr-001/commit`, { key: KEY_MAIN, body: {} }), { params: { holdId: 'hold-cr-001' } })
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, 'HOLD_RELEASED')

    const nf = await commitRoute.POST(mkReq('POST', `${BASE}/claim/hold-nexist-0000000000000/commit`, { key: KEY_MAIN, body: {} }), { params: { holdId: 'hold-nexist-0000000000000' } })
    assert.equal(nf.status, 404)
  })
})

describe('DELETE /v1/bookable-slots/claim/{holdId}', () => {
  it('HELD → RELEASED（200；apricotRef null）+ audit', async () => {
    await seedHold('HELD')
    const res = await releaseRoute.DELETE(mkReq('DELETE', `${BASE}/claim/hold-cr-001`, { key: KEY_MAIN }), { params: { holdId: 'hold-cr-001' } })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.status, 'RELEASED')
    assert.equal(json.apricotRef, null)
    assert.equal(heldRows[0].status, 'RELEASED')
    assert.ok(auditCreates.find((x) => x.action === 'PROVIDER_HOLD_RELEASE'))
  })

  it('IN_APRICOT → RELEASED 帶 apricotRef（caller 清理 Apricot 邊）', async () => {
    await seedHold('IN_APRICOT')
    const res = await releaseRoute.DELETE(mkReq('DELETE', `${BASE}/claim/hold-cr-001`, { key: KEY_MAIN }), { params: { holdId: 'hold-cr-001' } })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.apricotRef, 'apr-apt-9')
  })

  it('冪等：已 RELEASED → 200；不存在 → 404', async () => {
    await seedHold('RELEASED')
    const res = await releaseRoute.DELETE(mkReq('DELETE', `${BASE}/claim/hold-cr-001`, { key: KEY_MAIN }), { params: { holdId: 'hold-cr-001' } })
    assert.equal(res.status, 200)
    const nf = await releaseRoute.DELETE(mkReq('DELETE', `${BASE}/claim/hold-nexist-0000000000000`, { key: KEY_MAIN }), { params: { holdId: 'hold-nexist-0000000000000' } })
    assert.equal(nf.status, 404)
  })
})

// ── GET /v1/bookable-slots/held（PII-free 警報數據）──────────────────

describe('GET /v1/bookable-slots/held', () => {
  it('200 形狀過 zod + 零病人資料 + holdTimeoutHours 帶出', async () => {
    const row = await seedHold('HELD', 600)
    row.createdAt = new Date(Date.now() - 13 * 3600 * 1000) // 13 小時前 → 未來日 = appointmentPast false
    const res = await heldGET(mkReq('GET', `${BASE}/held?clinicCode=TKW`, { key: KEY_MAIN }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.v, 1)
    assert.equal(body.holdTimeoutHours, 24)
    assert.ok(z.array(HeldRowSchema).safeParse(body.holds).success, 'holds zod fail')
    assert.equal(body.holds.length, 1)
    const h = body.holds[0]
    assert.equal(h.holdId, 'hold-cr-001')
    assert.equal(h.providerName, 'Dr. Ho')
    assert.equal(h.appointmentPast, false)
    assert.ok(h.ageHours >= 12.9 && h.ageHours <= 13.2)
    assertZeroPii(body, 'held')
  })

  it('status filter + 無 clinicCode（全店）都過', async () => {
    await seedHold('HELD')
    const r1 = await heldGET(mkReq('GET', `${BASE}/held?status=HELD`, { key: KEY_MAIN }))
    assert.equal(r1.status, 200)
    assert.equal((await r1.json()).holds.length, 1)
    const r2 = await heldGET(mkReq('GET', `${BASE}/held?status=IN_APRICOT`, { key: KEY_MAIN }))
    assert.equal((await r2.json()).holds.length, 0)
    const bad = await heldGET(mkReq('GET', `${BASE}/held?status=BOGUS`, { key: KEY_MAIN }))
    assert.equal(bad.status, 400)
  })
})

// ── fixture 錨定 ─────────────────────────────────────────────────────

const FIXTURE_PATH = fileURLToPath(new URL('../../../../../../test/fixtures/external-v1-bookable-slots.json', import.meta.url))
const FIXTURE_SHA256 = 'e6e5e855cf3528f2c114eb8f7a9d6ad80ac24a2e1fd58748ccb8e3b974eacbd2'

describe('fixture 契約', () => {
  it('fixture 檔存在 + sha256 錨定（Stage 4 wa-inbox 對照用）', () => {
    const raw = readFileSync(FIXTURE_PATH)
    const actual = createHash('sha256').update(raw).digest('hex')
    assert.equal(actual, FIXTURE_SHA256, 'fixture sha256 漂移 — 改咗 sample 要重新對')
  })

  it('fixture 過 zod schema（MD 3.1 形狀）', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    const parsed = GetV1Schema.safeParse(fixture)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
  })
})

// ── 守門（§A.2）──────────────────────────────────────────────────────

describe('401/403/429', () => {
  it('401（缺 key / 錯 key）+ 403（scope）+ 429（狂打）', async () => {
    const noKey = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${D0}&to=${D0}`))
    assert.equal(noKey.status, 401)
    const badKey = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${D0}&to=${D0}`, {
      key: 'ext-test-bs-wrong-00000000000000000000000000000000000000000000000000000000',
    }))
    assert.equal(badKey.status, 401)

    const noScope = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${D0}&to=${D0}`, { key: KEY_NOSCOPE }))
    assert.equal(noScope.status, 403)
    assert.equal((await noScope.json()).code, 'FORBIDDEN')

    let counts: Record<number, number> = {}
    for (let i = 0; i < 61; i++) {
      const res = await GET(mkReq('GET', `${BASE}?clinicCode=TKW&from=${D0}&to=${D0}`, { key: KEY_BURST }))
      counts[res.status] = (counts[res.status] ?? 0) + 1
    }
    assert.equal(counts[200], 60)
    assert.equal(counts[429], 1)
  })
})
