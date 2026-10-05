/**
 * ★ cwi-qa FX-30 (QA-30) — clinical-index 穩定性 contract test
 *
 * 覆蓋施工單 4 項驗收：
 *   ① APRICOT_BUSY → 停當晚、cursor 唔前進（舊口徑當單個病人錯誤跳過 → 病人永久漏）
 *   ② job 級 advisory lock：並發 2 個 runExclusive（= route 並發 POST）→ 第二個 { running: true }
 *      → route 409 ALREADY_RUNNING（lock 放開後第三個先入）
 *   ③ 回填 DONE 後再 POST（無 restart）→ ALREADY_DONE、零 Apricot call、冇新 job；
 *      ?restart=1 → 先開新一輪
 *   ④ 殘留 RUNNING 7 小時（deploy 殺 request）→ 下晚夜跑標 FAILED(ABANDONED) + 補掃嗰日；
 *      新 RUNNING（2 小時）唔誤殺
 *
 * 全 mock（同 t694-apricot-lock.test.ts 慣例）：
 *   - basePrisma fake（clinicalIndexJob / clinic / clinicalRxCode / clinicalRecordIndex）
 *   - callFn 注入（runClinicalIndexBackfill/Nightly 直接收 callFn — 唔打真 Apricot）
 *   - job-lock 經 setJobLockClientFactoryForTest 注入真 mutex 語義 fake
 *   - CLINICAL_INDEX_RATE_MS=0（限速 sleep 關閉 — 秒回）
 * 唔打真 Apricot、唔郁真 DB。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { basePrisma } from '../prisma'
import { resetRxCodeCache } from '../clinical/extract-rx-codes'
import { runClinicalIndexBackfill, type BackfillOutcome } from './backfill'
import { runClinicalIndexNightly } from './nightly'
import { runExclusive, setJobLockClientFactoryForTest, CLINICAL_INDEX_LOCK_KEY, type ClinicalIndexJobKind } from './job-lock'
import { POST as backfillPost } from '../../app/api/internal/clinical-index-backfill/route'

type Any = any

// ── env（call-time 讀）────────────────────────────────────────────────
process.env.CLINICAL_INDEX_RATE_MS = '0'

// ── fake basePrisma ───────────────────────────────────────────────────
type JobRow = Any
const jobs: JobRow[] = []
let jobSeq = 0

function matchJob(j: JobRow, where: Any): boolean {
  if (where.kind != null && j.kind !== where.kind) return false
  if (where.status != null) {
    if (where.status.in) { if (!where.status.in.includes(j.status)) return false }
    else if (j.status !== where.status) return false
  }
  if (where.startedAt != null) {
    if (where.startedAt.lt && !(j.startedAt && j.startedAt < where.startedAt.lt)) return false
  }
  return true
}
function project(row: JobRow | null | undefined, select?: Any): Any {
  if (!row) return null
  if (!select) return { ...row }
  const out: Any = {}
  for (const k of Object.keys(select)) out[k] = row[k]
  return out
}

const recordRows: Any[] = []
const fakes = {
  clinicalIndexJob: {
    findFirst: async ({ where, orderBy, select }: Any) => {
      let rows = jobs.filter((j) => matchJob(j, where))
      if (orderBy?.startedAt === 'desc') rows = [...rows].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      if (orderBy?.finishedAt === 'desc') rows = [...rows].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      return project(rows[0], select)
    },
    findMany: async ({ where, select }: Any) => jobs.filter((j) => matchJob(j, where)).map((j) => project(j, select)),
    create: async ({ data }: Any) => {
      const row: JobRow = { id: `job-${++jobSeq}`, status: 'PENDING', ...data }
      jobs.push(row)
      return { ...row }
    },
    update: async ({ where, data }: Any) => {
      const row = jobs.find((j) => j.id === where.id)
      if (row) Object.assign(row, data)
      return row ? { ...row } : null
    },
  },
  clinic: { findMany: async () => [{ id: 'cl-1', apricotClinicId: 'apr-1' }] },
  clinicalRxCode: { findMany: async () => [] },
  clinicalRecordIndex: {
    findFirst: async () => null,
    findUnique: async () => null,
    upsert: async ({ create }: Any) => ({ id: 'row-1', ...create }),
    create: async ({ data }: Any) => ({ id: 'row-1', ...data }),
    update: async () => ({ count: 1 }),
    findMany: async () => recordRows,
    count: async () => 0,
  },
}

let saved: [Any, string, Any][] = []
before(() => {
  resetRxCodeCache()
  for (const k of Object.keys(fakes) as (keyof typeof fakes)[]) {
    saved.push([basePrisma, k, (basePrisma as Any)[k]])
    Object.defineProperty(basePrisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})
after(() => {
  setJobLockClientFactoryForTest(null)
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
})
beforeEach(() => {
  jobs.length = 0
  recordRows.length = 0
  jobSeq = 0
})

const d = (s: string) => new Date(`${s}T00:00:00Z`)

// ── ① APRICOT_BUSY → 停當晚、cursor 唔前進 ───────────────────────────
describe('FX-30 ① APRICOT_BUSY 停當晚（cursor 唔前進）', () => {
  it('search 即 BUSY → PAUSED_BUSY、job 照 RUNNING、cursor = 開跑日、零患者處理', async () => {
    // 預建一個已開跑嘅 BACKFILL job（cursor 喺 mid-range）
    jobs.push({
      id: 'job-seed', kind: 'BACKFILL',
      rangeFrom: d('2025-09-27'), rangeTo: d('2026-09-26'),
      cursorDate: d('2026-05-01'),
      status: 'RUNNING', patients: 100, apiCalls: 10, errors: 0, lastError: null,
      startedAt: new Date('2026-09-25T03:00:00Z'), finishedAt: null,
    })
    const busyErr = new Error('APRICOT_BUSY')
    let calls = 0
    const r: BackfillOutcome = await runClinicalIndexBackfill({
      now: new Date('2026-09-27T03:30:00Z'),
      callFn: async () => { calls++; throw busyErr },
    })
    assert.equal(r.status, 'PAUSED_BUSY')
    assert.equal(r.lastError, 'APRICOT_BUSY')
    assert.equal(calls, 1, 'BUSY 即刻停 — 唔會重試到死')
    assert.equal(r.patients, 0)

    // DB 落庫：cursor 冇前進（= 開跑日 2026-05-01）、status 照 RUNNING（第二晚續）
    const job = jobs.find((j) => j.id === 'job-seed')!
    assert.equal(job.status, 'RUNNING')
    assert.equal(job.cursorDate.toISOString(), d('2026-05-01').toISOString(), 'cursor 唔前進 — 第二晚重試呢日')
    assert.equal(job.lastError, 'APRICOT_BUSY')
  })
})

// ── ② job 級 lock：並發 → 第二個 409 語義 ────────────────────────────
describe('FX-30 ② job 級 advisory lock（並發 409 語義）', () => {
  it('兩個 runExclusive 並發 → 第二個 { running: true }；放開後第三個先入；lock key 分離（BACKFILL≠NIGHTLY）', async () => {
    // 真 mutex 語義 fake：per-key 持鎖狀態
    const heldBy = new Map<number, symbol>()
    let seq = 0
    setJobLockClientFactoryForTest(async (kind: ClinicalIndexJobKind) => {
      const key = CLINICAL_INDEX_LOCK_KEY[kind]
      const id = Symbol(`client-${++seq}`)
      return {
        query: async (sql: string) => {
          if (/try_advisory_lock/.test(sql)) {
            const free = !heldBy.has(key)
            if (free) heldBy.set(key, id)
            return { rows: [{ locked: free }] }
          }
          if (/advisory_unlock/.test(sql)) {
            if (heldBy.get(key) === id) heldBy.delete(key)
            return { rows: [{ ok: true }] }
          }
          return { rows: [] }
        },
        release: () => {},
      }
    })

    let release1: () => void
    const gate1 = new Promise<void>((res) => { release1 = res })
    const p1 = runExclusive('BACKFILL', async () => { await gate1; return 'first-done' })

    // 等第一條攞到鎖（fake 全同步 — 一個 microtask 夠）
    await new Promise((r) => setTimeout(r, 5))
    const p2 = await runExclusive('BACKFILL', async () => 'should-not-run')
    assert.deepEqual(p2, { running: true }, '並發第二個 = 攞唔到鎖 → route 層 409 ALREADY_RUNNING')

    // NIGHTLY 鎖同 BACKFILL 分離 — 唔會互鎖
    const p3 = await runExclusive('NIGHTLY', async () => 'nightly-ok')
    assert.equal(p3.running, false)
    assert.equal((p3 as Any).result, 'nightly-ok')

    // 放開 BACKFILL → 第三個先入
    release1!()
    const r1 = await p1
    assert.equal((r1 as Any).result, 'first-done')
    const p4 = await runExclusive('BACKFILL', async () => 'third-ok')
    assert.equal((p4 as Any).result, 'third-ok')
  })

  it('route 層：lock 被佔 → POST 回 409 ALREADY_RUNNING；lock 空 → 200（ALREADY_DONE 短電，零 Apricot）；無 key → 403', async () => {
    const savedKey = process.env.APRICOT_CRON_KEY
    process.env.APRICOT_CRON_KEY = 'test-cron-key-fx30'
    try {
      // (a) 鎖被佔 → 409（fn 根本唔會行 — 零 Apricot risk）
      setJobLockClientFactoryForTest(async () => ({
        query: async () => ({ rows: [{ locked: false }] }),
        release: () => {},
      }))
      const r409 = await backfillPost(new NextRequest('http://127.0.0.1:3000/api/internal/clinical-index-backfill', {
        method: 'POST',
        headers: { 'x-cron-key': 'test-cron-key-fx30' },
      }))
      assert.equal(r409.status, 409)
      assert.deepEqual(await r409.json(), { error: 'ALREADY_RUNNING' })

      // (b) 鎖空 + 已有 DONE job → 200 ALREADY_DONE（唔打 Apricot）
      jobs.push({
        id: 'job-done-route', kind: 'BACKFILL',
        rangeFrom: d('2025-09-27'), rangeTo: d('2026-09-26'),
        cursorDate: null,
        status: 'DONE', patients: 9000, apiCalls: 29000, errors: 3, lastError: null,
        startedAt: new Date('2026-09-20T03:30:00Z'), finishedAt: new Date('2026-09-24T06:00:00Z'),
      })
      setJobLockClientFactoryForTest(async () => ({
        query: async (sql: string) => ({ rows: /try_advisory_lock/.test(sql) ? [{ locked: true }] : [] }),
        release: () => {},
      }))
      const r200 = await backfillPost(new NextRequest('http://127.0.0.1:3000/api/internal/clinical-index-backfill', {
        method: 'POST',
        headers: { 'x-cron-key': 'test-cron-key-fx30' },
      }))
      assert.equal(r200.status, 200)
      const body = await r200.json()
      assert.equal(body.status, 'ALREADY_DONE')

      // (c) 無 key → 403（守門優先於 lock）
      const r403 = await backfillPost(new NextRequest('http://127.0.0.1:3000/api/internal/clinical-index-backfill', {
        method: 'POST',
        headers: { 'x-cron-key': 'wrong' },
      }))
      assert.equal(r403.status, 403)
    } finally {
      if (savedKey === undefined) delete process.env.APRICOT_CRON_KEY
      else process.env.APRICOT_CRON_KEY = savedKey
      setJobLockClientFactoryForTest(null)
    }
  })
})

// ── ③ 回填 DONE 唔自動重開 ───────────────────────────────────────────
describe('FX-30 ③ 回填 DONE 唔自動重開（?restart=1 先開）', () => {
  it('已有 DONE job、無 restart → ALREADY_DONE、零 Apricot call、冇新 job', async () => {
    jobs.push({
      id: 'job-done', kind: 'BACKFILL',
      rangeFrom: d('2025-09-27'), rangeTo: d('2026-09-26'),
      cursorDate: null,
      status: 'DONE', patients: 9000, apiCalls: 29000, errors: 3, lastError: null,
      startedAt: new Date('2026-09-20T03:30:00Z'), finishedAt: new Date('2026-09-24T06:00:00Z'),
    })
    let calls = 0
    const r = await runClinicalIndexBackfill({
      now: new Date('2026-09-29T03:30:00Z'),
      callFn: async () => { calls++; return [] },
    })
    assert.equal(r.status, 'ALREADY_DONE')
    assert.equal(calls, 0, 'ALREADY_DONE 唔打 Apricot')
    assert.equal(jobs.length, 1, '冇開新 job（舊口徑會再開 365 日）')
  })

  it('DONE + restart=true → 開新一輪（新 job、rangeFrom = today-365）', async () => {
    jobs.push({
      id: 'job-done', kind: 'BACKFILL',
      rangeFrom: d('2025-09-27'), rangeTo: d('2026-09-26'),
      cursorDate: null,
      status: 'DONE', patients: 9000, apiCalls: 29000, errors: 3, lastError: null,
      startedAt: new Date('2026-09-20T03:30:00Z'), finishedAt: new Date('2026-09-24T06:00:00Z'),
    })
    // daysPerRun=1 → 一晚一日（search 回空）— 快收
    const r = await runClinicalIndexBackfill({
      now: new Date('2026-09-29T03:30:00Z'),
      daysPerRun: 1,
      restart: true,
      callFn: async () => [],
    })
    assert.notEqual(r.status, 'ALREADY_DONE')
    assert.equal(jobs.length, 2, '開咗新 job')
    const fresh = jobs.find((j) => j.id !== 'job-done')!
    assert.equal(fresh.kind, 'BACKFILL')
    assert.equal(fresh.status, 'RUNNING', '未跑完 365 日 — 照 RUNNING 續')
    assert.equal(fresh.rangeFrom.toISOString(), d('2025-09-29').toISOString(), '新一輪 = today(2026-09-29)-365')
    assert.equal(fresh.cursorDate.toISOString(), d('2025-09-30').toISOString(), '跑完 1 日 cursor 前進')
  })

  it('無 DONE job（首次）→ 照常開跑（唔受 FX-30 影響）', async () => {
    const r = await runClinicalIndexBackfill({
      now: new Date('2026-09-29T03:30:00Z'),
      daysPerRun: 1,
      callFn: async () => [],
    })
    assert.notEqual(r.status, 'ALREADY_DONE')
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].status, 'RUNNING')
  })
})

// ── ④ 殘留 RUNNING 補掃 ──────────────────────────────────────────────
describe('FX-30 ④ 殘留 RUNNING（deploy 殺 request）下晚補掃', () => {
  it('RUNNING 7 小時 + rangeFrom=前日 → 標 FAILED(ABANDONED) + 補掃嗰日（search 真打咗 2 個日）', async () => {
    jobs.push({
      id: 'job-ghost', kind: 'NIGHTLY',
      rangeFrom: d('2026-09-25'), rangeTo: d('2026-09-25'),
      status: 'RUNNING', patients: 0, apiCalls: 5, errors: 0, lastError: null,
      startedAt: new Date('2026-09-26T20:00:00Z'), finishedAt: null, // 7 小時前
    })
    // 由 search request body 提 HK 日（lastVisitStartDate = hkDateStart = HK 午夜 → +8h 還原 HK 日）
    const searchedDays = new Set<string>()
    const r = await runClinicalIndexNightly({
      now: new Date('2026-09-27T03:00:00Z'), // yesterday = 2026-09-26
      callFn: async (path: string, init?: Any) => {
        if (path.includes('clinic-patients/search')) {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
          const iso = body?.params?.find((p: Any) => p.key === 'lastVisitStartDate')?.value
          if (typeof iso === 'string') {
            searchedDays.add(new Date(new Date(iso).getTime() + 8 * 3_600_000).toISOString().slice(0, 10))
          }
        }
        return []
      },
    })
    assert.equal(r.status, 'DONE')
    assert.equal(r.scanDate, '2026-09-26')
    assert.deepEqual(r.extraScanDates, ['2026-09-25'], '殘留嗰日 = 補掃日')
    assert.deepEqual([...searchedDays].sort(), ['2026-09-25', '2026-09-26'], 'search 真打咗補掃日 + 昨日（唔係只打昨日）')

    // 殘骸 job → FAILED + ABANDONED + finishedAt
    const ghost = jobs.find((j) => j.id === 'job-ghost')!
    assert.equal(ghost.status, 'FAILED')
    assert.match(ghost.lastError, /ABANDONED/)
    assert.ok(ghost.finishedAt instanceof Date)

    // 新 job 行 rangeFrom = 最早補掃日
    const fresh = jobs.find((j) => j.id !== 'job-ghost')!
    assert.equal(fresh.rangeFrom.toISOString(), d('2026-09-25').toISOString())
    assert.equal(fresh.rangeTo.toISOString(), d('2026-09-26').toISOString())
  })

  it('RUNNING 2 小時（活緊）→ 唔誤殺、唔補掃', async () => {
    jobs.push({
      id: 'job-live', kind: 'NIGHTLY',
      rangeFrom: d('2026-09-26'), rangeTo: d('2026-09-26'),
      status: 'RUNNING', patients: 0, apiCalls: 5, errors: 0, lastError: null,
      startedAt: new Date('2026-09-27T01:00:00Z'), finishedAt: null, // 2 小時前
    })
    const r = await runClinicalIndexNightly({
      now: new Date('2026-09-27T03:00:00Z'),
      callFn: async () => [],
    })
    assert.equal(r.status, 'DONE')
    assert.deepEqual(r.extraScanDates, [], '新 RUNNING 唔係殘骸 — 唔補掃')
    const live = jobs.find((j) => j.id === 'job-live')!
    assert.equal(live.status, 'RUNNING', '活緊嘅 job 唔郁')
  })

  it('APRICOT_BUSY 喺夜跑 → FAILED + lastError 含 BUSY（停當晚）', async () => {
    const r = await runClinicalIndexNightly({
      now: new Date('2026-09-27T03:00:00Z'),
      callFn: async () => { throw new Error('APRICOT_BUSY') },
    })
    assert.equal(r.status, 'FAILED')
    assert.equal(r.stopReason, 'APRICOT_UNAVAILABLE')
    assert.equal(r.lastError, 'APRICOT_BUSY')
    const fresh = jobs[jobs.length - 1]
    assert.equal(fresh.status, 'FAILED', 'job 落庫 FAILED — 唔會永遠 RUNNING')
  })
})
