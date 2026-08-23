/**
 * POST /v1/bookings + status/remove/reschedule + GET /v1/dictionaries
 * — contract test + MD §6 驗收（mock 版）— cw-apricotwrite-20260823-a1
 *
 * 全 mock：setTestCallFn（唔打真 Apricot）+ fake prisma（monkey-patch）。
 * 覆蓋（§6 逐項 mock 版）：
 *   - 200 形狀 zod strict + 負面 PII 斷言
 *   - 冪等重放同 apricotApptId（create 只打一次）
 *   - status=4 → 400（白名單釘住）
 *   - remove 係 PUT 釘住（module 只 export PUT — POST/DELETE 唔存在）
 *   - APRICOT_WRITE=0 → 503 WRITE_DISABLED（四條寫入 route 全數）
 *   - NEW_PATIENT_DISABLED 422（flag off）
 *   - 409 SLOT_TAKEN
 *   - reschedule 新單 fail → 502 + WriteLog ERROR:create_after_102
 *   - WriteLog 全動作有底（CREATE/STATUS_102/STATUS_-7/REMOVE/RESCHEDULE）
 *   - audit 零 PII（四欄，無 query）
 *   - 401/403/429（§A.2 守門）
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from '../../../../../lib/prisma'
import { setTestCallFn } from '../../../../../lib/apricot/write-booking'
import { todayHK, addDaysStr } from '../../../../../lib/hk-date'
import { POST } from './route'
import * as statusRoute from './[id]/status/route'
import * as removeRoute from './[id]/remove/route'
import * as rescheduleRoute from './[id]/reschedule/route'
import { GET as dictionariesGET } from '../dictionaries/route'

type Any = any

// ── 時間 ─────────────────────────────────────────────────────────────
const BOOK_DATE = addDaysStr(todayHK(), 7)
const OLD_DATE = addDaysStr(todayHK(), -1)

// ── 測試假 key ───────────────────────────────────────────────────────
const KEY_MAIN = 'ext-test-key-main-0000000000000000000000000000000000000000000000000000'
const KEY_NOSCOPE = 'ext-test-key-noscope-00000000000000000000000000000000000000000000000000'
const KEY_BURST = 'ext-test-key-burst-0000000000000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const KEY_ROWS = [
  { id: 'k-main', name: 'contract-key-main', keyHash: sha(KEY_MAIN), scopes: ['availability', 'bookings'], active: true, lastUsedAt: null },
  { id: 'k-noscope', name: 'contract-key-noscope', keyHash: sha(KEY_NOSCOPE), scopes: ['availability'], active: true, lastUsedAt: null },
  { id: 'k-burst', name: 'contract-key-burst', keyHash: sha(KEY_BURST), scopes: ['bookings'], active: true, lastUsedAt: null },
]

// ── fake Apricot call ────────────────────────────────────────────────
interface Call { path: string; method?: string; body?: any }
const calls: Call[] = []
let respond: (c: Call) => any = () => ({})
const mockCall: Any = (path: string, init?: Any) => {
  const c: Call = { path, method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
  calls.push(c)
  return Promise.resolve(respond(c))
}
function overviewRaw(dateStr: string): Any {
  const [y, m, d] = dateStr.split('-').map(Number)
  const utc = (hkMin: number) => new Date(Date.UTC(y, m - 1, d, 0, 0) + hkMin * 60_000 - 8 * 3600_000).toISOString()
  return {
    [dateStr]: {
      appointments: {
        'prov-1': {
          practitionerOpenSchs: { timeSlots: [{ startTime: 900, endTime: 1800 }] },
          bookingDetail: [{ bookingTime: utc(540), bookingEndTime: utc(570), bookingStatus: 0, isRemoved: false }],
        },
      },
    },
  }
}

// ── fake prisma ──────────────────────────────────────────────────────
const writeLogs = new Map<string, Any>()
const dictRows: Any[] = []
const cacheRows: Any[] = []
let locked = true
const auditCreates: Any[] = []
const keyUpdates: Any[] = []

const fakes = {
  $queryRaw: async (strings: Any) => {
    const sql = typeof strings === 'object' && strings.join ? strings.join('?') : String(strings)
    return [{ locked: /try_advisory_lock/.test(sql) ? locked : null }]
  },
  externalApiKey: {
    findMany: async () => KEY_ROWS,
    update: async (args: Any) => { keyUpdates.push(args); return {} },
  },
  externalApiAudit: {
    create: async (args: Any) => { auditCreates.push(args.data); return {} },
  },
  clinic: {
    findFirst: async () => ({ id: 'cl-tkw', shortName: 'TKW', apricotClinicId: 'apr-clinic-1' }),
    findUnique: async () => ({ id: 'cl-tkw', apricotClinicId: 'apr-clinic-1' }),
  },
  provider: { findMany: async () => [{ apricotId: 'prov-1', name: 'Dr. T' }] },
  bookingWriteLog: {
    findUnique: async ({ where }: Any) => writeLogs.get(where.idempotencyKey) ?? null,
    upsert: async ({ where, update, create }: Any) => {
      const key = where.idempotencyKey
      const existing = writeLogs.get(key)
      if (existing) Object.assign(existing, update)
      else {
        const row = { id: `log-${key}`, createdAt: new Date(), ...create }
        writeLogs.set(key, row)
      }
      return writeLogs.get(key)
    },
  },
  apricotDictionary: {
    findFirst: async ({ where }: Any) => {
      const rows = dictRows.filter((r) => r.kind === where.kind)
      return rows.length ? { syncedAt: rows[0].syncedAt } : null
    },
    findMany: async ({ where }: Any) => dictRows.filter((r) => r.kind === where.kind && r.isRemoved === where.isRemoved),
    upsert: async ({ where, update, create }: Any) => {
      const i = dictRows.findIndex((r) => r.apricotId === where.apricotId)
      if (i >= 0) dictRows[i] = { ...dictRows[i], ...update }
      else dictRows.push(create)
      return dictRows.find((r) => r.apricotId === where.apricotId)!
    },
  },
  availabilityCache: {
    deleteMany: async (args: Any) => {
      for (let i = cacheRows.length - 1; i >= 0; i--) {
        const r = cacheRows[i]
        if (r.clinicId === args.where.clinicId && (!args.where.date || r.date === args.where.date)) cacheRows.splice(i, 1)
      }
      return { count: 0 }
    },
    createMany: async ({ data }: Any) => { cacheRows.push(...data); return { count: data.length } },
  },
  $transaction: async (arg: Any) => (Array.isArray(arg) ? Promise.all(arg) : arg()),
}

let saved: [Any, string, Any][] = []
const envSaved: string[] = []
before(() => {
  setTestCallFn(mockCall)
  envSaved.push(process.env.APRICOT_WRITE ?? '', process.env.ALLOW_NEW_PATIENT_WRITE ?? '')
  process.env.APRICOT_WRITE = '1'
  process.env.ALLOW_NEW_PATIENT_WRITE = '0'
  for (const obj of [prisma, basePrisma]) {
    for (const k of Object.keys(fakes) as (keyof typeof fakes)[]) {
      saved.push([obj, k, (obj as Any)[k]])
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
  }
})
after(() => {
  setTestCallFn(null)
  ;(process.env as Any).APRICOT_WRITE = envSaved[0]
  ;(process.env as Any).ALLOW_NEW_PATIENT_WRITE = envSaved[1]
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
})
beforeEach(() => {
  calls.length = 0
  writeLogs.clear()
  dictRows.length = 0
  cacheRows.length = 0
  auditCreates.length = 0
  keyUpdates.length = 0
  locked = true
  respond = (c) => {
    if (c.path.includes('checkClash')) return []
    if (c.path.endsWith('/booking-details') && c.method === 'POST') {
      return { id: 'apt-new-1', clinicPatient: { id: 'pat-1', code: 'P0001' } }
    }
    if (c.path.startsWith('/services/aepsmsappt/api/appointments/getOverviewAppointments')) {
      const qs = new URLSearchParams(c.path.split('?')[1] ?? '')
      return overviewRaw(qs.get('startDate') ?? BOOK_DATE)
    }
    if (c.path.includes('/visit-reasons')) return { list: [{ id: 'vr-1', code: '01', des: 'Follow-up' }] }
    if (c.path.includes('/booking-types')) return [{ id: 'bt-1', code: 'T1', des: 'Consultation' }]
    return {}
  }
})

// ── request 助手 ─────────────────────────────────────────────────────
const BASE = 'http://localhost:3000/api/external/v1'
function mkReq(method: string, url: string, opts: { key?: string; body?: Any } = {}): NextRequest {
  const headers: Record<string, string> = {}
  if (opts.key) headers['x-api-key'] = opts.key
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  return new NextRequest(`${BASE}${url}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined })
}

function bookingBody(over: Any = {}): Any {
  return {
    v: 1,
    idempotencyKey: 'idemp-key-0001',
    clinicCode: 'TKW',
    providerApricotId: 'prov-1',
    date: BOOK_DATE,
    start: '14:30',
    durationMin: 30,
    visitReasonId: 'vr-1',
    patient: { patientApricotId: 'pat-1' },
    ...over,
  }
}

const createCallCount = () => calls.filter((c) => c.path.endsWith('/booking-details') && c.method === 'POST').length
const PII_PATTERNS = ['medicalHistory', 'personalIdentifier', 'visitReasons', 'phoneNum', 'diagnosis', '98765432']

/** flag 臨時改 + finally 還原（防 env 洩漏去其他 test） */
function withWriteFlag(val: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.APRICOT_WRITE
  process.env.APRICOT_WRITE = val
  return fn().finally(() => { process.env.APRICOT_WRITE = prev })
}

// ── zod 契約（MD §5 200 形狀）────────────────────────────────────────
const CreateBookingV1Schema = z.object({
  v: z.literal(1),
  apricotApptId: z.string().min(1),
  bookingStatus: z.literal(0),
  patientApricotId: z.string().nullable(),
  patientCode: z.string().nullable(),
  dayRefreshed: z.boolean(),
  syncedAt: z.string().nullable(),
}).strict()

// ── C.1 contract ─────────────────────────────────────────────────────

describe('POST /v1/bookings — 200 契約', () => {
  it('200 形狀過 zod strict + 負面 PII 斷言（MD §5）', async () => {
    const res = await POST(mkReq('POST', '/bookings', { key: KEY_MAIN, body: bookingBody() }))
    assert.equal(res.status, 200)
    const body = await res.json()
    const parsed = CreateBookingV1Schema.safeParse(body)
    assert.ok(parsed.success, `zod fail: ${JSON.stringify(parsed.error?.issues)}`)
    assert.equal(body.apricotApptId, 'apt-new-1')
    assert.equal(body.bookingStatus, 0)
    assert.equal(body.patientApricotId, 'pat-1')
    assert.equal(body.patientCode, 'P0001')
    assert.equal(body.dayRefreshed, true)
    assert.ok(body.syncedAt)
    for (const p of PII_PATTERNS) {
      assert.ok(!JSON.stringify(body).includes(p), `response 含 PII：${p}`)
    }
  })

  it('hostile create response（塞 PII）→ response 仍零 PII', async () => {
    const prev = respond
    respond = (c) => {
      if (c.path.endsWith('/booking-details') && c.method === 'POST') {
        return {
          id: 'apt-new-1',
          clinicPatient: { id: 'pat-1', code: 'P0001', phoneNum: '98765432', medicalHistory: 'x', diagnosis: 'y', personalIdentifier: 'z' },
        }
      }
      return prev(c)
    }
    const res = await POST(mkReq('POST', '/bookings', { key: KEY_MAIN, body: bookingBody() }))
    assert.equal(res.status, 200)
    const raw = JSON.stringify(await res.json())
    for (const p of PII_PATTERNS) {
      assert.ok(!raw.includes(p), `response 含 PII：${p}`)
    }
  })

  it('§6：冪等重放同 apricotApptId、create 只打一次', async () => {
    const r1 = await POST(mkReq('POST', '/bookings', { key: KEY_MAIN, body: bookingBody() }))
    const r2 = await POST(mkReq('POST', '/bookings', { key: KEY_MAIN, body: bookingBody() }))
    assert.equal(r1.status, 200)
    assert.equal(r2.status, 200)
    const b1 = await r1.json()
    const b2 = await r2.json()
    assert.equal(b2.apricotApptId, b1.apricotApptId)
    assert.equal(createCallCount(), 1)
  })

  it('409 SLOT_TAKEN（checkClash 有衝突）', async () => {
    const prev = respond
    respond = (c) => (c.path.includes('checkClash') ? [{ x: 1 }] : prev(c))
    const res = await POST(mkReq('POST', '/bookings', { key: KEY_MAIN, body: bookingBody() }))
    assert.equal(res.status, 409)
    assert.deepEqual(await res.json(), { error: 'slot taken', code: 'SLOT_TAKEN' })
    assert.equal(createCallCount(), 0)
  })

  it('503 WRITE_DISABLED（APRICOT_WRITE=0 總閘）', async () => {
    await withWriteFlag('0', async () => {
      const res = await POST(mkReq('POST', '/bookings', { key: KEY_MAIN, body: bookingBody() }))
      assert.equal(res.status, 503)
      assert.deepEqual(await res.json(), { error: 'apricot write disabled', code: 'WRITE_DISABLED' })
      assert.equal(createCallCount(), 0)
    })
  })

  it('422 NEW_PATIENT_DISABLED（ALLOW_NEW_PATIENT_WRITE=0 + 新客 inline）', async () => {
    const res = await POST(mkReq('POST', '/bookings', {
      key: KEY_MAIN,
      body: bookingBody({ patient: { name: '王小明', phone: '91234567' } }),
    }))
    assert.equal(res.status, 422)
    assert.deepEqual(await res.json(), { error: 'new patient write disabled', code: 'NEW_PATIENT_DISABLED' })
    assert.equal(createCallCount(), 0)
  })

  it('新客 inline + flag on → 200（payload §0 原樣）', async () => {
    const prevAllow = process.env.ALLOW_NEW_PATIENT_WRITE
    process.env.ALLOW_NEW_PATIENT_WRITE = '1'
    try {
      const res = await POST(mkReq('POST', '/bookings', {
        key: KEY_MAIN,
        body: bookingBody({ patient: { name: '王小明', phone: '91234567' } }),
      }))
      assert.equal(res.status, 200)
      const post = calls.find((c) => c.path.endsWith('/booking-details') && c.method === 'POST')
      assert.deepEqual(post!.body.clinicPatient, {
        firstName: '王小明',
        phoneNum: '91234567',
        referralType: 'OTHER',
        privateSetting: { clinics: [], isPrivate: false },
      })
      assert.equal('bookingType' in post!.body, false)
      const body = await res.json()
      assert.equal(body.patientApricotId, 'pat-1')
    } finally {
      process.env.ALLOW_NEW_PATIENT_WRITE = prevAllow
    }
  })

  it('400 各款（格式/範圍/patient）', async () => {
    const cases: Any[] = [
      bookingBody({ idempotencyKey: 'short' }),
      bookingBody({ idempotencyKey: undefined }),
      bookingBody({ date: '2026-02-30' }),
      bookingBody({ date: addDaysStr(todayHK(), -3) }),
      bookingBody({ date: addDaysStr(todayHK(), 31) }),
      bookingBody({ start: '23:30', durationMin: 60 }),
      bookingBody({ start: '25:99' }),
      bookingBody({ durationMin: 0 }),
      bookingBody({ patient: { patientApricotId: 'p1', name: 'x', phone: '91234567' } }),
      bookingBody({ patient: {} }),
      bookingBody({ visitReasonId: undefined }),
    ]
    for (const b of cases) {
      const res = await POST(mkReq('POST', '/bookings', { key: KEY_MAIN, body: b }))
      assert.equal(res.status, 400, `應該 400：${JSON.stringify(b)}`)
      assert.equal((await res.json()).code, 'BAD_REQUEST')
    }
  })

  it('401（缺 key / 錯 key）+ 403（scope）+ 429（狂打）', async () => {
    const noKey = await POST(mkReq('POST', '/bookings', { body: bookingBody() }))
    assert.equal(noKey.status, 401)
    const badKey = await POST(mkReq('POST', '/bookings', { key: 'ext-test-key-wrong-00000000000000000000000000000000000000000000000000', body: bookingBody() }))
    assert.equal(badKey.status, 401)

    const noScope = await POST(mkReq('POST', '/bookings', { key: KEY_NOSCOPE, body: bookingBody() }))
    assert.equal(noScope.status, 403)
    assert.equal((await noScope.json()).code, 'FORBIDDEN')

    let counts: Record<number, number> = {}
    for (let i = 0; i < 61; i++) {
      const res = await POST(mkReq('POST', '/bookings', { key: KEY_BURST, body: bookingBody({ idempotencyKey: `idemp-burst-${i}` }) }))
      counts[res.status] = (counts[res.status] ?? 0) + 1
    }
    assert.equal(counts[200], 60)
    assert.equal(counts[429], 1)
  })
})

// ── status / remove / reschedule ─────────────────────────────────────

describe('PUT /v1/bookings/{id}/status', () => {
  it('§6：status=4 → 400（白名單釘住）', async () => {
    const res = await statusRoute.PUT(
      mkReq('PUT', `/bookings/apt-1/status?status=4&date=${BOOK_DATE}&clinicCode=TKW`, { key: KEY_MAIN }),
      { params: { id: 'apt-1' } },
    )
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, 'BAD_REQUEST')
    assert.equal(calls.length, 0)
  })

  it('status=102 → 200 { bookingStatus:102, dayRefreshed:true }', async () => {
    const res = await statusRoute.PUT(
      mkReq('PUT', `/bookings/apt-1/status?status=102&date=${BOOK_DATE}&clinicCode=TKW`, { key: KEY_MAIN }),
      { params: { id: 'apt-1' } },
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.bookingStatus, 102)
    assert.equal(body.dayRefreshed, true)
    assert.ok(body.syncedAt)
    assert.ok(calls.some((c) => c.path.includes('updateStatus?status=102')))
  })

  it('status=-7 → 200 { bookingStatus:-7, dayRefreshed:true }（-7 後 cache 即時反映 — 真 Apricot bookedCount 驗收入部署 checklist）', async () => {
    const res = await statusRoute.PUT(
      mkReq('PUT', `/bookings/apt-1/status?status=-7&date=${BOOK_DATE}&clinicCode=TKW`, { key: KEY_MAIN }),
      { params: { id: 'apt-1' } },
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.bookingStatus, -7)
    assert.equal(body.dayRefreshed, true)
  })

  it('503 WRITE_DISABLED（flag off）', async () => {
    await withWriteFlag('0', async () => {
      const res = await statusRoute.PUT(
        mkReq('PUT', `/bookings/apt-1/status?status=102&date=${BOOK_DATE}&clinicCode=TKW`, { key: KEY_MAIN }),
        { params: { id: 'apt-1' } },
      )
      assert.equal(res.status, 503)
      assert.equal((await res.json()).code, 'WRITE_DISABLED')
    })
  })

  it('缺 date/clinicCode → 400', async () => {
    const r1 = await statusRoute.PUT(mkReq('PUT', `/bookings/apt-1/status?status=102`, { key: KEY_MAIN }), { params: { id: 'apt-1' } })
    assert.equal(r1.status, 400)
    const r2 = await statusRoute.PUT(mkReq('PUT', `/bookings/apt-1/status?status=102&date=${BOOK_DATE}`, { key: KEY_MAIN }), { params: { id: 'apt-1' } })
    assert.equal(r2.status, 400)
  })
})

describe('PUT /v1/bookings/{id}/remove', () => {
  it('§6：remove 係 PUT 釘住（module 只 export PUT；POST/DELETE/GET 唔存在 → Next 405）', () => {
    assert.equal(typeof (removeRoute as Any).PUT, 'function')
    assert.equal(typeof (removeRoute as Any).POST, 'undefined')
    assert.equal(typeof (removeRoute as Any).DELETE, 'undefined')
    assert.equal(typeof (removeRoute as Any).GET, 'undefined')
  })

  it('200 { removed:true, dayRefreshed:true }；引擎打 PUT + body [id]（§0 實測）', async () => {
    const res = await removeRoute.PUT(
      mkReq('PUT', `/bookings/apt-9/remove?date=${BOOK_DATE}&clinicCode=TKW`, { key: KEY_MAIN }),
      { params: { id: 'apt-9' } },
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.removed, true)
    assert.equal(body.dayRefreshed, true)
    const call = calls.find((c) => c.path.includes('/remove'))
    assert.equal(call!.method, 'PUT')
    assert.deepEqual(call!.body, ['apt-9'])
  })

  it('503 WRITE_DISABLED（flag off）', async () => {
    await withWriteFlag('0', async () => {
      const res = await removeRoute.PUT(
        mkReq('PUT', `/bookings/apt-9/remove?date=${BOOK_DATE}&clinicCode=TKW`, { key: KEY_MAIN }),
        { params: { id: 'apt-9' } },
      )
      assert.equal(res.status, 503)
      assert.equal((await res.json()).code, 'WRITE_DISABLED')
    })
  })
})

describe('POST /v1/bookings/{id}/reschedule', () => {
  const body = () => ({
    v: 1,
    clinicCode: 'TKW',
    providerApricotId: 'prov-1',
    date: addDaysStr(BOOK_DATE, 1),
    start: '15:00',
    durationMin: 30,
    oldDate: BOOK_DATE,
    patient: { patientApricotId: 'pat-1' },
  })

  it('200 { oldApptId, newApptId, dayRefreshed:true }', async () => {
    const res = await rescheduleRoute.POST(mkReq('POST', '/bookings/apt-old/reschedule', { key: KEY_MAIN, body: body() }), { params: { id: 'apt-old' } })
    assert.equal(res.status, 200)
    const b = await res.json()
    assert.equal(b.oldApptId, 'apt-old')
    assert.equal(b.newApptId, 'apt-new-1')
    assert.equal(b.dayRefreshed, true)
  })

  it('§6：新單 fail → 502 + WriteLog ERROR:create_after_102（唔自動 rollback）', async () => {
    const prev = respond
    respond = (c) => {
      if (c.path.endsWith('/booking-details') && c.method === 'POST') throw new Error('APRICOT_HTTP_422: filled')
      return prev(c)
    }
    const res = await rescheduleRoute.POST(mkReq('POST', '/bookings/apt-old/reschedule', { key: KEY_MAIN, body: body() }), { params: { id: 'apt-old' } })
    assert.equal(res.status, 502)
    const b = await res.json()
    assert.match(b.code, /^APRICOT_ERROR:/)
    assert.ok([...writeLogs.values()].some((l) => l.status === 'ERROR:create_after_102'))
    // 舊單確實已標 102（殘留態成立）
    assert.ok(calls.some((c) => c.path.includes('updateStatus?status=102')))
    // 無 rollback
    assert.ok(!calls.some((c) => c.path.includes('updateStatus?status=-7') || c.path.includes('/remove')))
  })

  it('503 WRITE_DISABLED（flag off）', async () => {
    await withWriteFlag('0', async () => {
      const res = await rescheduleRoute.POST(mkReq('POST', '/bookings/apt-old/reschedule', { key: KEY_MAIN, body: body() }), { params: { id: 'apt-old' } })
      assert.equal(res.status, 503)
      assert.equal((await res.json()).code, 'WRITE_DISABLED')
    })
  })
})

// ── dictionaries ─────────────────────────────────────────────────────

describe('GET /v1/dictionaries', () => {
  it('isRemoved 剔走（§6 驗收項）', async () => {
    dictRows.push(
      { apricotId: 'vr-1', code: '01', des: 'Follow-up', isRemoved: false, kind: 'VISIT_REASON', syncedAt: new Date() },
      { apricotId: 'vr-2', code: '02', des: 'Removed', isRemoved: true, kind: 'VISIT_REASON', syncedAt: new Date() },
      { apricotId: 'bt-1', code: 'T1', des: 'Consultation', isRemoved: false, kind: 'BOOKING_TYPE', syncedAt: new Date() },
    )
    const res = await dictionariesGET(mkReq('GET', '/dictionaries?kind=VISIT_REASON', { key: KEY_MAIN }))
    assert.equal(res.status, 200)
    const b = await res.json()
    assert.deepEqual(b, { v: 1, kind: 'VISIT_REASON', items: [{ apricotId: 'vr-1', code: '01', des: 'Follow-up' }] })

    const res2 = await dictionariesGET(mkReq('GET', '/dictionaries?kind=BOOKING_TYPE', { key: KEY_MAIN }))
    const b2 = await res2.json()
    assert.equal(b2.items.length, 1)
    assert.equal(b2.items[0].code, 'T1')
  })

  it('kind 錯 / 缺 → 400', async () => {
    const r1 = await dictionariesGET(mkReq('GET', '/dictionaries?kind=NOPE', { key: KEY_MAIN }))
    assert.equal(r1.status, 400)
    const r2 = await dictionariesGET(mkReq('GET', '/dictionaries', { key: KEY_MAIN }))
    assert.equal(r2.status, 400)
  })

  it('scope 未授予 → 403（書本：dictionaries 亦行 bookings scope）', async () => {
    const res = await dictionariesGET(mkReq('GET', '/dictionaries?kind=VISIT_REASON', { key: KEY_NOSCOPE }))
    assert.equal(res.status, 403)
  })
})

// ── audit / WriteLog 底 ──────────────────────────────────────────────

describe('audit 零 PII + WriteLog 全動作有底（§6）', () => {
  it('audit 行只四欄（keyName/path/status/latencyMs）、path 無 query', async () => {
    await POST(mkReq('POST', '/bookings', { key: KEY_MAIN, body: bookingBody() }))
    const row = auditCreates[auditCreates.length - 1]
    assert.deepEqual(Object.keys(row).sort(), ['keyName', 'latencyMs', 'path', 'status'])
    assert.equal(row.keyName, 'contract-key-main')
    assert.equal(row.path, '/api/external/v1/bookings')
    assert.equal(row.status, 200)
    assert.ok(!String(row.path).includes('?'))
    // 401 亦有行（anonymous）
    await POST(mkReq('POST', '/bookings', { body: bookingBody() }))
    const row401 = auditCreates[auditCreates.length - 1]
    assert.equal(row401.keyName, 'anonymous')
    assert.equal(row401.status, 401)
  })

  it('WriteLog 全動作有底：CREATE / STATUS_102 / STATUS_-7 / REMOVE / RESCHEDULE', async () => {
    await POST(mkReq('POST', '/bookings', { key: KEY_MAIN, body: bookingBody() }))
    await statusRoute.PUT(mkReq('PUT', `/bookings/apt-1/status?status=102&date=${BOOK_DATE}&clinicCode=TKW`, { key: KEY_MAIN }), { params: { id: 'apt-1' } })
    await statusRoute.PUT(mkReq('PUT', `/bookings/apt-1/status?status=-7&date=${BOOK_DATE}&clinicCode=TKW`, { key: KEY_MAIN }), { params: { id: 'apt-1' } })
    await removeRoute.PUT(mkReq('PUT', `/bookings/apt-9/remove?date=${BOOK_DATE}&clinicCode=TKW`, { key: KEY_MAIN }), { params: { id: 'apt-9' } })
    await rescheduleRoute.POST(mkReq('POST', '/bookings/apt-old/reschedule', {
      key: KEY_MAIN,
      body: { v: 1, clinicCode: 'TKW', providerApricotId: 'prov-1', date: addDaysStr(BOOK_DATE, 1), start: '15:00', durationMin: 30, oldDate: BOOK_DATE, patient: { patientApricotId: 'pat-1' } },
    }), { params: { id: 'apt-old' } })

    const actions = new Set([...writeLogs.values()].map((l) => l.action))
    for (const a of ['CREATE', 'STATUS_102', 'STATUS_-7', 'REMOVE', 'RESCHEDULE']) {
      assert.ok(actions.has(a), `WriteLog 缺 action：${a}`)
    }
    // 🔴 零 PII：所有 log row 只白名單欄
    for (const row of writeLogs.values()) {
      assert.deepEqual(Object.keys(row).sort(), ['action', 'apricotApptId', 'createdAt', 'id', 'idempotencyKey', 'requestedBy', 'status'])
      assert.equal(typeof row.requestedBy, 'string')
      assert.ok(!JSON.stringify(row).includes('91234567'), 'WriteLog 含電話')
    }
  })
})
