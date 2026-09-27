/**
 * ★ cwi-final S6-8（W-7）T694 — clinical-index 同 Apricot 寫入共用 session token 嘅鎖驗收
 *
 * 背景：clinical-index（nightly/backfill/refresh 讀鏈）同 booking 寫入（write-booking）
 * 共用同一組 Apricot cookie；iat/access_token 逐 response rotate，並發即死
 * （APRICOT_AUTH_EXPIRED）。spec（2026-09-17）寫 S6-8 時 defaultCall 係裸 apricotCall；
 * 2026-09-18 commit 39976bd7（cwm-mgrmobile-ownerdash-ops-20260917「營運 P4-2～6…Apricot 搶鎖」）
 * 已將 defaultCall 改做：每個 call 包 withApricotLock（advisory lock 776001 — 同 sync/
 * write-booking 同一把），攞唔到 → 500ms（lock 外）重試，最多 20 次 → APRICOT_BUSY。
 * 本 test 將呢個行為鎖死（防將來有人「簡化」defaultCall 而 regress）：
 *
 *   ① 每次 clinical-index call 都經 advisory lock（try/unlock 計數；鎖 key 必須 776001）；
 *      事件序列證明限速 sleep 喺 lock 外（sequential 單 consumer 零 self-busy）
 *   ② nightly 讀鏈 ∥ createBooking（真並行，同一 mock Apricot single-session）
 *      → 零 in-flight overlap（token 無可能被搶）→ 零 401 / 冇 APRICOT_AUTH_EXPIRED；
 *      createBooking 撞鎖 = APRICOT_BUSY（正確串行結果，consumer 層重試後最終成功）
 *   ③ mutation control：裸 apricotCall ×2 並行（= P4-6 前行為）→ mock 必須計到
 *      overlap + 至少一個 APRICOT_AUTH_EXPIRED（證明 mock 抓得到 regression）
 *
 * 全 mock（同 write-booking.test.ts / backfill-appointments.test.ts 慣例）：
 *   - globalThis.fetch stub 模擬 Apricot single-session：第二個 request 撞入 in-flight
 *     window → 401（= token 搶鎖）；每次成功 response rotate Set-Cookie
 *   - prisma fake（externalCredential 真 enc/dec 路徑 + bookingWriteLog + day-sync 面）
 *   - lock 經 setApricotLockClientFactoryForTest 注入真 mutex 語義 fake
 *     （try 唔到 = locked:false，同 pg_try_advisory_lock 一致；unlock 只認原持鎖 client）
 * 唔打真 Apricot、唔郁真 DB。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { prisma, basePrisma } from '../prisma'
import { apricotCall } from '../apricot/client'
import { setApricotLockClientFactoryForTest } from '../apricot/lock'
import { createBooking, type CreateBookingInput } from '../apricot/write-booking'
import { makeThrottledCallFn, searchPatientsForDate, fetchPatientData } from './apricot-client'

type Any = any

// ── env（call-time 讀 — module 頂設定，import 順序無關）──────────────────
// 限速 sleep 400ms 鐵律 → test 內縮細（rateLimitMs() 係 call-time 讀 env）
process.env.CLINICAL_INDEX_RATE_MS = '2'
// token.ts enc/dec 用 AES-256-GCM — test-only 32-byte key（非生產 key）
const TEST_ENC_KEY = crypto.randomBytes(32)
process.env.APRICOT_ENC_KEY = TEST_ENC_KEY.toString('base64')

// ── enc/dec（同 token.ts 同方案；token.ts 未 export，test 自帶同型實作）──
function enc(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', TEST_ENC_KEY, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}
function dec(b64: string): string {
  const raw = Buffer.from(b64, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', TEST_ENC_KEY, raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

// ── mock Apricot（fetch stub）— single-session 建模 ─────────────────────
// 真 Apricot：cookie 三件套逐 response rotate；兩 request 同時 in-flight =
// 同一 session 被搶 → 401（apricotCall 翻譯做 APRICOT_AUTH_EXPIRED）。
const INFLIGHT_MS = 15
const mock = {
  requests: 0,
  overlap: 0,   // 第二個 request 撞入 in-flight window 嘅次數（= token 搶鎖事件）
  http401: 0,
  rotateCount: 0,
  byPath: new Map<string, number>(),
}
let inflight = 0
let token = 'tok-0'

const SEARCH_PATIENTS = [
  { cpId: 'CP-T694-A', fullName: 'Cheng Yee-fun', phoneNum: '91234567' },
  { cpId: 'CP-T694-B', fullName: 'Wong Tai-man', phoneNum: '91234568' },
]

function bodyFor(u: URL): Any {
  const p = u.pathname
  if (p.includes('clinic-patients/search')) return SEARCH_PATIENTS // 2 < 50 → 單 page 止
  if (p.startsWith('/services/aepsmsope/api/appointments/patient/')) return []
  if (p.startsWith('/services/aepsmsope/api/consultation-notes/patient/')) return []
  if (p.includes('bills/search')) return []
  if (p.includes('checkClash')) return [] // 無 clash
  if (p.endsWith('/booking-details')) return { id: 'apt-t694-1', clinicPatient: { id: 'pat-t694-1', code: 'T694-0001' } }
  if (p.startsWith('/services/aepsmsappt/api/appointments/getOverviewAppointments')) {
    // 同 write-booking.test.ts overviewRaw 形狀（bookingDetail 空 — 0 行重寫）
    const d = u.searchParams.get('startDate') ?? '2026-09-26'
    return {
      [d]: {
        appointments: {
          'prov-1': {
            practitionerOpenSchs: { timeSlots: [{ startTime: 900, endTime: 1200 }] },
            bookingDetail: [],
          },
        },
      },
    }
  }
  return {}
}

const realFetch = globalThis.fetch
async function fakeFetch(input: any, init?: any): Promise<Response> {
  void init
  const u = new URL(String(input))
  mock.requests++
  const key = u.pathname
  mock.byPath.set(key, (mock.byPath.get(key) ?? 0) + 1)
  inflight++
  const conflicted = inflight > 1 // 到齊時已有另一 request 未走完 = session 被搶
  if (conflicted) {
    mock.overlap++
    mock.http401++
  }
  await new Promise(r => setTimeout(r, INFLIGHT_MS))
  if (conflicted) {
    inflight--
    return new Response('auth failed', { status: 401, headers: { 'content-type': 'text/plain' } })
  }
  token = `tok-${++mock.rotateCount}` // 每次成功都 rotate（同真 Apricot）
  inflight--
  return new Response(JSON.stringify(bodyFor(u)), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': `access_token=${token}; Path=/` },
  })
}

// ── fake lock client（真 mutex 語義 + 計數 + key 守門）───────────────────
const LOCK_KEY = 776001 // 同 lock.ts / write-booking / sync 同一把
const lockStats = { tryCount: 0, unlockCount: 0, busyCount: 0 }
const lockEvents: Array<{ t: number; kind: 'try' | 'unlock'; locked: boolean }> = []
let holder: Any = null

function makeFakeLockFactory(): void {
  setApricotLockClientFactoryForTest(async () => {
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        if (/pg_try_advisory_lock/.test(sql)) {
          lockStats.tryCount++
          if (params?.[0] !== LOCK_KEY) {
            throw new Error(`T694: lock key ${String(params?.[0])} ≠ ${LOCK_KEY} — 必須同 sync/write-booking 同一把鎖`)
          }
          if (holder === null) {
            holder = client
            lockEvents.push({ t: Date.now(), kind: 'try', locked: true })
            return { rows: [{ locked: true }] }
          }
          lockStats.busyCount++
          lockEvents.push({ t: Date.now(), kind: 'try', locked: false })
          return { rows: [{ locked: false }] }
        }
        if (/pg_advisory_unlock/.test(sql)) {
          if (holder === client) {
            holder = null
            lockStats.unlockCount++
            lockEvents.push({ t: Date.now(), kind: 'unlock', locked: true })
          }
          return { rows: [] }
        }
        return { rows: [] }
      },
      release: () => {},
    }
    return client
  })
}

// ── prisma fake（real apricotCall 經 token.ts loadCreds/saveCreds；createBooking 引擎面）
const credsState = { accessToken: 'tok-0', refreshToken: 'rt-0', iat: 'iat-0' }
const writeLogs = new Map<string, Any>()
const dictRows = new Map<string, Any>()
const cacheRows: Any[] = []

const fakes = {
  $queryRaw: async (strings: Any) => {
    const sql = typeof strings === 'object' && strings.join ? strings.join('?') : String(strings)
    return [{ locked: /try_advisory_lock/.test(sql) ? true : null }]
  },
  $transaction: async (arg: Any) => (Array.isArray(arg) ? Promise.all(arg) : arg()),
  externalCredential: {
    findUnique: async () => ({
      id: 'cred-apricot',
      provider: 'APRICOT',
      cipherText: enc(JSON.stringify(credsState)),
      lastError: null,
      rotationCount: 0,
    }),
    update: async ({ data }: Any) => {
      if (data?.cipherText) Object.assign(credsState, JSON.parse(dec(data.cipherText)))
      return { id: 'cred-apricot' }
    },
  },
  bookingWriteLog: {
    findUnique: async ({ where }: Any) => writeLogs.get(where.idempotencyKey) ?? null,
    upsert: async ({ where, update, create }: Any) => {
      const key = where.idempotencyKey
      const existing = writeLogs.get(key)
      if (existing) Object.assign(existing, update)
      else writeLogs.set(key, { id: `log-${key}`, createdAt: new Date(), ...create })
      return writeLogs.get(key)!
    },
    updateMany: async () => ({ count: 0 }),
  },
  // createBooking clash 路（dedup 查）— mock 恆無 clash，此路唔行
  appointmentIndex: {
    findFirst: async () => null,
    upsert: async () => ({}),
  },
  // day-sync（syncAvailabilityCacheSingleDay）面 — 同 write-booking.test.ts 慣例
  apricotPractitioner: { findMany: async () => [{ apricotId: 'prov-1', providerId: 'p-1', kind: 'PROVIDER' }] },
  provider: { findMany: async () => [{ id: 'p-1', name: 'Dr. T' }] },
  apricotDictionary: {
    findFirst: async () => null,
    upsert: async ({ where, update, create }: Any) => {
      const r = { ...create, ...update }
      dictRows.set(where.apricotId, r)
      return r
    },
  },
  patientIndex: { upsert: async () => ({}) },
  availabilityCache: {
    deleteMany: async ({ where }: Any) => {
      for (let i = cacheRows.length - 1; i >= 0; i--) {
        if (cacheRows[i].clinicId === where.clinicId && (!where.date || cacheRows[i].date === where.date)) {
          cacheRows.splice(i, 1)
        }
      }
      return { count: 0 }
    },
    createMany: async ({ data }: Any) => {
      cacheRows.push(...data)
      return { count: data.length }
    },
  },
  clinic: {
    findUnique: async () => ({ id: 'cl-1', apricotClinicId: 'apr-clinic-1' }),
    findMany: async () => [{ id: 'cl-1', name: 'T694 Clinic', apricotClinicId: 'apr-clinic-1' }],
  },
}

let saved: [Any, string, Any][] = []
function installFakes(): void {
  for (const obj of [prisma, basePrisma]) {
    for (const k of Object.keys(fakes) as (keyof typeof fakes)[]) {
      saved.push([obj, k, (obj as Any)[k]])
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
  }
}
function restoreFakes(): void {
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
  saved = []
}

// ── helpers ─────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function waitFor(cond: () => boolean, timeoutMs: number, msg: string): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${msg}`)
    await sleep(2)
  }
}
function resetCounters(): void {
  mock.requests = 0
  mock.overlap = 0
  mock.http401 = 0
  mock.rotateCount = 0
  mock.byPath.clear()
  inflight = 0
  lockStats.tryCount = 0
  lockStats.unlockCount = 0
  lockStats.busyCount = 0
  lockEvents.length = 0
  holder = null
  writeLogs.clear()
  dictRows.clear()
  cacheRows.length = 0
}

const DATE = '2026-09-26'

before(() => {
  installFakes()
  makeFakeLockFactory()
  globalThis.fetch = fakeFetch as Any
})
after(() => {
  restoreFakes()
  setApricotLockClientFactoryForTest(null)
  globalThis.fetch = realFetch
})
beforeEach(() => resetCounters())

describe('T694 — clinical-index Apricot lock（S6-8 / W-7）', () => {
  it('① 每次 clinical-index call 都經 advisory lock（776001）；限速 sleep 喺 lock 外', async () => {
    const { call, calls } = makeThrottledCallFn() // 預設 base = defaultCall（真 apricotCall → fetch stub）
    const paths = [
      '/services/aepsmsope/api/clinic-patients/search?page=0&sort=asc&sortBy=fullName&keyword=',
      '/services/aepsmsope/api/appointments/patient/CP-T694-A?page=0&size=20&sort=desc',
      '/services/aepsmsope/api/consultation-notes/patient/CP-T694-A?page=0&size=8&sort=desc&filter=',
      '/services/aepsmsbill/api/bills/search?page=0&size=50&sort=desc&keyword=&sortBy=billTime',
    ]
    for (const p of paths) await call(p, {})

    assert.equal(calls(), 4)
    assert.equal(lockStats.tryCount, 4, '每個 call 都 try_lock')
    assert.equal(lockStats.unlockCount, 4, '每個 call 都 unlock（無漏鎖）')
    assert.equal(holder, null, '結尾無殘留持鎖')
    assert.equal(lockStats.busyCount, 0, 'sequential 單 consumer 零 self-busy = 限速/重試 sleep 都喺 lock 外')
    assert.equal(mock.overlap, 0, '鎖串行下 Apricot 零 in-flight 撞車')
    assert.equal(mock.http401, 0)

    // 事件序列：try→unlock→try→unlock…（unlock 嚴格早於下一次 try）
    const seq = lockEvents.map(e => (e.kind === 'try' ? (e.locked ? 'T' : 't') : 'U'))
    assert.deepEqual(seq, ['T', 'U', 'T', 'U', 'T', 'U', 'T', 'U'])
    for (let i = 0; i + 1 < lockEvents.length; i++) {
      assert.ok(lockEvents[i].t <= lockEvents[i + 1].t, 'lock 事件時序')
    }
    const firstUnlock = lockEvents.find(e => e.kind === 'unlock')!
    const secondTry = lockEvents.filter(e => e.kind === 'try')[1]
    assert.ok(secondTry.t >= firstUnlock.t, '第二次 try 喺第一次 unlock 之後（sleep 唔持鎖）')
  })

  it('② nightly 讀鏈 ∥ createBooking → 零 overlap、冇 APRICOT_AUTH_EXPIRED、booking 最終成功', async () => {
    // nightly 側：nightly.ts:102/113 同款讀鏈（search 全 page + 逐病人 3 call）— 真 defaultCall
    const nightly = (async () => {
      const { call, calls } = makeThrottledCallFn()
      const patients = await searchPatientsForDate(call, DATE)
      assert.equal(patients.length, 2)
      const out: Any = {}
      for (const p of patients) out[p.cpId] = await fetchPatientData(call, p.cpId, DATE)
      return { out, n: calls() }
    })()

    // 等 nightly 第一個 call 真正持鎖（可觀測狀態 — 唔靠 wall-clock 猜 contention）
    await waitFor(() => holder !== null, 5000, 'nightly 首 call 應持鎖')

    // createBooking 側：真 write-booking 引擎（call = 真 apricotCall → 同一 mock Apricot）
    const input: CreateBookingInput = {
      idempotencyKey: 't694-key-0001',
      clinicCuid: 'cl-1',
      apricotClinicId: 'apr-clinic-1',
      providerApricotId: 'prov-1',
      dateHk: DATE,
      startHk: '14:30',
      durationMin: 30,
      visitReasonId: 'vr-1',
      patient: { apricotId: 'pat-t694-1' },
      requestedBy: 't694',
    }
    let booking: Any = null
    let busyRetries = 0
    for (let i = 0; i < 25 && !booking; i++) {
      try {
        booking = await createBooking(input)
      } catch (e: Any) {
        if (e?.name === 'ApricotWriteError' && e?.code === 'APRICOT_BUSY') {
          busyRetries++ // 撞鎖 = 正確串行結果（consumer 層重試）
          await sleep(20)
          continue
        }
        throw e
      }
    }
    const night = await nightly

    // W-7 核心不變式：兩側零 in-flight 撞車 → session token 無可能被搶
    assert.equal(mock.overlap, 0, 'nightly ∥ createBooking 全程零 Apricot in-flight overlap')
    assert.equal(mock.http401, 0, '零 401 = 冇 APRICOT_AUTH_EXPIRED')
    assert.ok(busyRetries >= 1, `lock contention 應真實發生（觀測到 busy=${busyRetries}）`)

    assert.ok(booking, 'createBooking 最終成功（APRICOT_BUSY 重試後）')
    assert.equal(booking.replayed, false)
    assert.equal(booking.apricotApptId, 'apt-t694-1')
    assert.equal(booking.dayRefreshed, true, '同 lock 內單日 sync 照行')

    assert.equal(night.n, 7, 'nightly 讀鏈 = 1 search + 2 病人 × 3 call')
    for (const cp of [SEARCH_PATIENTS[0].cpId, SEARCH_PATIENTS[1].cpId]) {
      assert.deepEqual(night.out[cp], { appointments: [], notes: [], bills: [] })
    }

    assert.equal(holder, null, '結尾無殘留持鎖')
    assert.ok(lockStats.tryCount >= 11, `兩側所有 Apricot call 都 try_lock（觀測 ${lockStats.tryCount}）`)
    assert.equal(lockStats.unlockCount, lockStats.tryCount - lockStats.busyCount, '每次攞到都解鎖')
  })

  it('③ mutation control：裸 apricotCall ×2 並行（P4-6 前行為）→ 必出 overlap + APRICOT_AUTH_EXPIRED', async () => {
    const p1 = apricotCall('/services/aepsmsope/api/clinic-patients/search?page=0&sort=asc&sortBy=fullName&keyword=', {
      method: 'POST',
      body: JSON.stringify({ params: [] }),
    })
    const p2 = apricotCall('/services/aepsmsope/api/appointments/patient/CP-T694-A?page=0&size=20&sort=desc')
    const [r1, r2] = await Promise.allSettled([p1, p2])

    assert.ok(mock.overlap >= 1, 'mock 計到 in-flight 撞車')
    const rejects = [r1, r2].filter(r => r.status === 'rejected')
    assert.ok(rejects.length >= 1, '至少一個 call 因 token 搶鎖而失敗')
    const msg = (rejects[0] as Any).reason?.message ?? ''
    assert.match(msg, /APRICOT_AUTH_EXPIRED/, '失敗形式 = APRICOT_AUTH_EXPIRED')
  })
})
