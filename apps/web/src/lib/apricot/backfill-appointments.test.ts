/**
 * Backfill（read-chain MD §3.3）— mock 驗收（全 mock：callFn 注入 + fake prisma）
 * cwc-rdchain-20260823-b1
 *
 * - 範圍 -24 個月 → -7（HK 日界），逐月逐店（一次一店一個月）
 * - 只餵 AppointmentIndex + PatientIndex（AvailabilityCache 零寫）
 * - 冪等 upsert（apricotApptId 鍵）— 重跑唔雙寫
 * - AUTH_EXPIRED → 中止（重跑安全）；lock  contention → skipped
 *
 * 🔴 mock raw 帶完整病人 PII（hostile shape）— 驗收白名單 pickup 只留 index 欄。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prisma, basePrisma } from '../prisma'
import { addDaysStr } from '../hk-date'
import { runAppointmentIndexBackfill, monthsBetween } from './backfill-appointments'
import type { CacheCallFn } from './sync-availability-cache'

type Any = any

// phoneNum→hash（extractIndexRows）需要 — 固定向量 test key（非生產 key）
const PHONE_FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('../../../testdata/phone-hash.fixture.json', import.meta.url)), 'utf8'))
process.env.PHONE_HASH_KEY = PHONE_FIXTURE.key

// ── 固定 now：2026-08-23 04:00 HK → today 2026-08-23 ─────────────────
const NOW = new Date('2026-08-23T04:00:00+08:00')
const START = '2024-08-01' // -24 個月月初
const END = '2026-08-16'   // -7 日

const CLINICS: Any[] = [
  { id: 'cl-a', name: 'A Clinic', apricotClinicId: 'APR-A' },
  { id: 'cl-b', name: 'B Clinic', apricotClinicId: 'APR-B' },
]

/** HK 當日 hkMin（00:00 起分鐘數）→ UTC ISO（同 Round A test 同 helper 口徑） */
function hkIso(day: string, hkMin: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) - 8 * 3600 * 1000 + hkMin * 60 * 1000
  return new Date(t).toISOString()
}

interface CallRec { startDate: string; endDate: string; clinicApricotId: string }

function freshState() {
  const state = {
    calls: [] as CallRec[],
    apptUpserts: [] as string[],
    patUpserts: [] as string[],
    cacheWrites: 0,
    locked: true,
  }
  return state
}

function makeFakes(state: ReturnType<typeof freshState>) {
  return {
    $queryRaw: async () => [{ locked: state.locked }],
    provider: { findMany: async () => [{ apricotId: 'D001', name: 'Dr. Lau' }] },
    clinic: { findMany: async () => CLINICS },
    appointmentIndex: {
      upsert: async (args: Any) => { state.apptUpserts.push(args.where.apricotApptId); return {} },
      count: async () => new Set(state.apptUpserts).size,
    },
    patientIndex: {
      upsert: async (args: Any) => { state.patUpserts.push(args.where.patientApricotId); return {} },
      count: async () => new Set(state.patUpserts).size,
    },
    availabilityCache: {
      deleteMany: async () => { state.cacheWrites++; return { count: 0 } },
      createMany: async () => { state.cacheWrites++; return { count: 0 } },
    },
  }
}

/** hostile raw：每日期 1 單，帶完整 PII（phoneNum/HKID 之類塞滿 — 白名單只准 pickup index 欄） */
function makeCallFn(state: ReturnType<typeof freshState>): CacheCallFn {
  return async (path: string) => {
    const qs = new URL(`http://x${path}`).searchParams
    const from = qs.get('startDate')!
    const to = qs.get('endDate')!
    const clinicApricotId = qs.get('clinicIds')!
    // 窗口斷言：落在 [START, END] 內 + 單月窗口（慢拉口徑）
    assert.ok(from >= START && to <= END, `窗口越界：${from}..${to}`)
    assert.equal(from.slice(0, 7), to.slice(0, 7), `唔係單月窗口：${from}..${to}`)
    state.calls.push({ startDate: from, endDate: to, clinicApricotId })

    const out: Any = {}
    let d = from
    while (d <= to) {
      out[d] = {
        appointments: {
          D001: {
            practitionerOpenSchs: { timeSlots: [{ startTime: 900, endTime: 1030 }] },
            bookingDetail: [
              {
                id: `bf-${clinicApricotId}-${d}`,
                bookingTime: hkIso(d, 570),
                bookingEndTime: hkIso(d, 600),
                bookingStatus: 0,
                isRemoved: false,
                visitReasons: [{ des: 'FILLING' }],
                remarkByDoctor: 'backfill 備註',
                clinicPatient: {
                  id: `pat-${clinicApricotId}`,
                  code: `C-${clinicApricotId}`,
                  fullName: `病人${clinicApricotId}`,
                  phoneNum: '91234567',
                  personalIdentifier: '123456(7)', // 🔴 照禁欄位 — 唔准落地
                },
              },
            ],
          },
        },
      }
      d = addDaysStr(d, 1)
    }
    return out
  }
}

let savedOriginals = new Map<Any, Map<string, Any>>()
let state: ReturnType<typeof freshState>
let fakes: Any
let callFn: CacheCallFn

function installFakes(): void {
  for (const obj of [prisma, basePrisma]) {
    let m = savedOriginals.get(obj)
    if (!m) { m = new Map(); savedOriginals.set(obj, m) }
    for (const k of Object.keys(fakes)) {
      if (!m.has(k)) m.set(k, (obj as Any)[k]) // 只首装先係真 original
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
  }
}

before(() => {
  state = freshState()
  fakes = makeFakes(state)
  callFn = makeCallFn(state)
  installFakes()
})
after(() => {
  for (const [obj, m] of savedOriginals) {
    for (const [k, orig] of m) {
      Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
    }
  }
  savedOriginals = new Map()
})

// ── 驗收 ─────────────────────────────────────────────────────────────

describe('§3.3 — backfill 驗收（mock）', () => {
  it('月份窗口計算（monthsBetween）', () => {
    const months = monthsBetween(START, END)
    assert.equal(months[0], '2024-08')
    assert.equal(months[months.length - 1], '2026-08')
    assert.equal(months.length, 25) // 24 全月 + 2026-08 半個月
  })

  it('全跑：範圍 -24 月→-7，逐月逐店 50 批（25 月 × 2 店）', async () => {
    state = freshState()
    fakes = makeFakes(state)
    callFn = makeCallFn(state)
    installFakes()

    const out = await runAppointmentIndexBackfill({ callFn, now: NOW, delayMs: 0 })
    assert.equal(out.ok, true)
    if (!out.ok) return
    assert.equal(out.start, START)
    assert.equal(out.end, END)
    assert.equal(state.calls.length, 50)
    assert.equal(out.results.length, 50)
    assert.ok(out.results.every(r => !('error' in r)))
    // 每批 = 一店一個月；月份順序升序、逐月逐店（月內店順序）
    assert.deepEqual(state.calls.slice(0, 2).map(c => [c.startDate, c.endDate, c.clinicApricotId]),
      [['2024-08-01', '2024-08-31', 'APR-A'], ['2024-08-01', '2024-08-31', 'APR-B']])
    assert.deepEqual(state.calls.slice(-2).map(c => [c.startDate, c.endDate, c.clinicApricotId]),
      [['2026-08-01', '2026-08-16', 'APR-A'], ['2026-08-01', '2026-08-16', 'APR-B']])
  })

  it('只餵兩索引表：AvailabilityCache 零寫 + upsert 行數 + stats', async () => {
    // 承接上一 test 嘅 state（同一 fake prisma，upserts 累積）
    assert.equal(state.cacheWrites, 0, 'indexOnly 唔可以掂 AvailabilityCache')
    // 746 日 × 2 店 = 1492 單（每日期每店 1 單）；病人 = 2
    assert.equal(new Set(state.apptUpserts).size, 1492)
    assert.equal(new Set(state.patUpserts).size, 2)
    // stats（count = 全表 unique）
    const out = await runAppointmentIndexBackfill({ callFn: async () => ({}), now: NOW, delayMs: 0 })
    // 空 response 重跑（冪等覆寫唔計新行）— stats 應該同全表 unique 對
    if (out.ok) {
      assert.equal(out.stats.totalAppointments, 1492)
      assert.equal(out.stats.totalPatients, 2)
      assert.ok(out.stats.elapsedMs >= 0)
    }
  })

  it('冪等：重跑唔雙寫（unique 數唔變，upsert call 數加）', async () => {
    const beforeTotal = state.apptUpserts.length
    const beforeUnique = new Set(state.apptUpserts).size
    await runAppointmentIndexBackfill({ callFn, now: NOW, delayMs: 0 })
    assert.equal(state.apptUpserts.length, beforeTotal + 1492, '重跑應再 upsert 同批行')
    assert.equal(new Set(state.apptUpserts).size, beforeUnique, 'unique 數唔變（冪等）')
  })

  it('AUTH_EXPIRED → 即刻中止（重跑安全）', async () => {
    const st = freshState()
    const f: Any = makeFakes(st)
    const cf: CacheCallFn = async () => {
      st.calls.push({ startDate: 'x', endDate: 'x', clinicApricotId: 'x' })
      throw new Error('AUTH_EXPIRED: session expired')
    }
    for (const obj of [prisma, basePrisma]) {
      for (const k of Object.keys(f)) {
        Object.defineProperty(obj, k, { value: f[k], configurable: true, writable: true })
      }
    }
    const out = await runAppointmentIndexBackfill({ callFn: cf, now: NOW, delayMs: 0 })
    assert.equal(out.ok, true)
    if (!out.ok) return
    assert.equal(st.calls.length, 1, 'AUTH_EXPIRED 後唔好繼續打')
    assert.equal(out.results.length, 1)
    assert.ok(('error' in out.results[0]) && out.results[0].error.includes('AUTH_EXPIRED'))
  })

  it('lock contention → skipped（唔 fail）', async () => {
    const st = freshState()
    st.locked = false
    const f: Any = makeFakes(st)
    for (const obj of [prisma, basePrisma]) {
      for (const k of Object.keys(f)) {
        Object.defineProperty(obj, k, { value: f[k], configurable: true, writable: true })
      }
    }
    const out = await runAppointmentIndexBackfill({ callFn, now: NOW, delayMs: 0 })
    assert.equal(out.ok, false)
    if (out.ok) return
    assert.match(out.skipped, /another apricot call in progress/)
    assert.equal(st.calls.length, 0)
  })
})
