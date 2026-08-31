/**
 * ★ cw-patwk (2026-08-22): sync 收 from —— 窗口行為測試
 * 跑法: cd apps/web && npx tsx --test src/lib/apricot/sync-availability-window.test.ts
 *
 * 覆蓋：
 * - resolveSyncWindow 純函數（from 有效／壞／無 → fallback 今日）
 * - 來源守門：start/end 單一來源（deleteMany 同寫入唔會分家 → #13 防線）
 * - runAvailabilitySync / syncAvailability（fake prisma + fake callFn）：
 *   ★ #13 同步下週窗口 → deleteMany 只覆蓋下週（本週唔受影響，本週資料仲喺）
 *   ★ #16 唔傳 from（cron 路徑）→ 仍然「今日起 7 日」
 * - POST route（真 token + fake prisma）：
 *   #12 from = 下週 → 200 拉下週
 *   #15 from = 過去 → 400「唔可以同步過去嘅日期」
 *   #14 from > +60 日 → 400「只可以同步未來 60 日內嘅資料」
 *   from 格式壞 → 400；無 body → 200 默认窗口
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { NextRequest } from 'next/server'
import { prisma } from '../prisma'
import { setApricotLockClientFactoryForTest } from './lock'
import { createToken } from '../auth'
import { todayHK, addDaysStr } from '../hk-date'
import {
  resolveSyncWindow,
  runAvailabilitySync,
  syncAvailability,
} from './sync-availability'
import { POST } from '../../app/api/provider-availability/sync/route'

const HERE = dirname(fileURLToPath(import.meta.url))
type Any = any

// ---- fixtures ----------------------------------------------------------------
const CLINIC = { id: 'c1', name: 'Test Clinic', apricotClinicId: '9001' }
const PROVIDER = { id: 'p1', apricotId: 'D001', isActive: true }

/** fake Apricot：記錄每次請求嘅 start/end，對請求窗口逐日回一個 FULL 開診時段（無 booking） */
function makeCallFn(reqLog: { start: string; end: string }[]) {
  return async (path: string) => {
    const qs = new URLSearchParams(path.split('?')[1] ?? '')
    const start = qs.get('startDate') ?? ''
    const end = qs.get('endDate') ?? ''
    reqLog.push({ start, end })
    const raw: Record<string, Any> = {}
    let cur = start
    let guard = 0
    while (cur && cur <= end && guard < 31) {
      raw[cur] = {
        appointments: {
          D001: { practitionerOpenSchs: { timeSlots: [{ startTime: 1000, endTime: 2000 }] } },
        },
      }
      cur = addDaysStr(cur, 1)
      guard += 1
    }
    return raw
  }
}

// ---- fake prisma（唔真連 DB；同 provider-availability-route.test.ts 同一 pattern）----
const users: Record<string, Any> = {}
const calls: Array<{ table: string; op: string; args: Any }> = []

const fakes: Record<string, Any> = {
  user: {
    findUnique: async (args: Any) => users[args?.where?.id] ?? null,
  },
  clinic: {
    count: async () => 0,
    findMany: async () => [CLINIC],
  },
  provider: {
    findMany: async () => [PROVIDER],
  },
  providerAvailability: {
    deleteMany: async (args: Any) => { calls.push({ table: 'providerAvailability', op: 'deleteMany', args }); return { count: 1 } },
    createMany: async (args: Any) => { calls.push({ table: 'providerAvailability', op: 'createMany', args }); return { count: args?.data?.length ?? 0 } },
  },
  providerBooking: {
    deleteMany: async (args: Any) => { calls.push({ table: 'providerBooking', op: 'deleteMany', args }); return { count: 0 } },
    createMany: async (args: Any) => { calls.push({ table: 'providerBooking', op: 'createMany', args }); return { count: 0 } },
  },
  $transaction: async (ops: Any[]) => { for (const op of ops) await op; return ops }, // ★ op 係 thenable（prisma batch promise），await 唔好 call
  $queryRaw: async () => [{ locked: true }], // withApricotLock：advisory lock 假裝攞到
  externalCredential: { findUnique: async () => null }, // loadCreds → null → APRICOT_NOT_CONFIGURED（無 HTTP，hermetic）
}

const saved: Record<string, Any> = {}
before(() => {
  for (const k of Object.keys(fakes)) {
    saved[k] = (prisma as Any)[k]
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
  // cwi-refresh-20260831：lock 改用 dedicated pg client — fake 經 test seam inject
  setApricotLockClientFactoryForTest(async () => ({
    query: async (sql: string) => ({ rows: [{ locked: /try_advisory_lock/.test(sql) ? true : null }] }),
    release: () => {},
  }))
})
after(() => {
  for (const k of Object.keys(saved)) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
  setApricotLockClientFactoryForTest(null)
})

// ---- 1. resolveSyncWindow 純函數 ----------------------------------------------
describe('resolveSyncWindow —— from 參數（cw-patwk §3.2）', () => {
  it('無 from → 今日起 7 日（cron 舊行為唔變）', () => {
    const t = todayHK()
    assert.deepEqual(resolveSyncWindow(undefined), { start: t, end: addDaysStr(t, 6) })
  })
  it('格式壞 from → fallback 今日', () => {
    const t = todayHK()
    for (const bad of ['2026-8-5', '08/29/2026', '2026-08-29T00:00:00Z', 'garbage', '']) {
      assert.deepEqual(resolveSyncWindow(bad), { start: t, end: addDaysStr(t, 6) }, `bad from=${JSON.stringify(bad)}`)
    }
  })
  it('有效 from → 嗰日起 7 日', () => {
    assert.deepEqual(resolveSyncWindow('2026-08-29'), { start: '2026-08-29', end: '2026-09-04' })
  })
  it('跨月計算正確', () => {
    assert.deepEqual(resolveSyncWindow('2026-08-30'), { start: '2026-08-30', end: '2026-09-05' })
  })
})

// ---- 2. 來源守門：單一窗口來源 -------------------------------------------------
describe('來源守門 —— deleteMany 同寫入窗口同一來源（#13 防線）', () => {
  const src = readFileSync(join(HERE, 'sync-availability.ts'), 'utf8')
  it('addDaysStr(start, 6) 全檔只出現一次（只喺 resolveSyncWindow）', () => {
    assert.equal((src.match(/addDaysStr\(start, 6\)/g) ?? []).length, 1)
  })
  it('冇任何 call site 再直接算 const start = hkTodayStr()', () => {
    assert.doesNotMatch(src, /const start = hkTodayStr\(\)/)
  })
  it('runAvailabilitySync 將已算好嘅 start 傳落 syncAvailability（窗口唔會分家）', () => {
    assert.match(src, /syncAvailability\(clinicRef, callFn, \{ from: start \}\)/)
  })
})

// ---- 3. 引擎窗口行為（fake prisma + fake callFn）------------------------------
describe('runAvailabilitySync / syncAvailability —— 窗口正確性', () => {
  it('#13 同步下週窗口 → deleteMany 只覆蓋下週，本週資料唔受影響', async () => {
    calls.length = 0
    const today = todayHK()
    const nextStart = addDaysStr(today, 7)
    const nextEnd = addDaysStr(today, 13)
    const reqLog: Array<{ start: string; end: string }> = []

    const outcome = await runAvailabilitySync({ from: nextStart, callFn: makeCallFn(reqLog) })
    assert.equal(outcome.ok, true)
    const r = outcome as Any
    assert.equal(r.start, nextStart)
    assert.equal(r.end, nextEnd)

    // Apricot 請求窗口 = 下週
    assert.deepEqual(reqLog[0], { start: nextStart, end: nextEnd })

    // ★ deleteMany（兩張表）窗口 = 下週 + clinicId；本週唔喺窗口內 → 本週資料仲喺
    const dels = calls.filter(c => c.op === 'deleteMany')
    assert.equal(dels.length, 2)
    for (const d of dels) {
      assert.equal(d.args.where.clinicId, CLINIC.id)
      assert.deepEqual(d.args.where.date, { gte: nextStart, lte: nextEnd })
      assert.ok(today < d.args.where.date.gte, '本週日期唔可以被刪')
    }

    // createMany 寫入行全部落喺下週窗口內
    const creates = calls.filter(c => c.table === 'providerAvailability' && c.op === 'createMany')
    assert.equal(creates.length, 1)
    assert.equal(creates[0].args.data.length, 7)
    for (const row of creates[0].args.data) {
      assert.ok(row.date >= nextStart && row.date <= nextEnd, `寫入日期 ${row.date} 唔喺下週窗口`)
    }
    assert.ok(outcome.ok === true && (r.results as Any[]).length === 1)
    assert.equal(r.results[0].open, 7)
  })

  it('#16 唔傳 from（cron 路徑）→ 仍然今日起 7 日', async () => {
    calls.length = 0
    const today = todayHK()
    const reqLog: Array<{ start: string; end: string }> = []

    const outcome = await runAvailabilitySync({ callFn: makeCallFn(reqLog) })
    assert.equal(outcome.ok, true)
    const r = outcome as Any
    assert.equal(r.start, today)
    assert.equal(r.end, addDaysStr(today, 6))
    assert.deepEqual(reqLog[0], { start: today, end: addDaysStr(today, 6) })
    const dels = calls.filter(c => c.op === 'deleteMany')
    assert.equal(dels.length, 2)
    for (const d of dels) {
      assert.deepEqual(d.args.where.date, { gte: today, lte: addDaysStr(today, 6) })
    }
  })

  it('syncAvailability 單行 from → 窗口同外層一致（單一來源）', async () => {
    calls.length = 0
    const from = addDaysStr(todayHK(), 14)
    const reqLog: Array<{ start: string; end: string }> = []
    const res = await syncAvailability(CLINIC, makeCallFn(reqLog), { from })
    assert.equal(res.open, 7)
    assert.deepEqual(reqLog[0], { start: from, end: addDaysStr(from, 6) })
    const dels = calls.filter(c => c.op === 'deleteMany')
    assert.equal(dels.length, 2)
    for (const d of dels) {
      assert.deepEqual(d.args.where.date, { gte: from, lte: addDaysStr(from, 6) })
    }
  })
})

// ---- 4. POST route 邊界（真 token + fake prisma）--------------------------------
function makeUser(id: string) {
  users[id] = { tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null, clinics: [{ clinicId: 'c1' }] }
  return createToken({ userId: id, role: 'MANAGER', clinics: ['c1'], tokenVersion: 1 })
}

function makePostReq(token: string, body?: Any) {
  return new NextRequest('http://localhost/api/provider-availability/sync', {
    method: 'POST',
    headers: { cookie: `session=${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

describe('POST /api/provider-availability/sync —— from 驗證（#12 #14 #15）', () => {
  it('#12 from = 下週首日 → 200，拉下週窗口', async () => {
    const today = todayHK()
    const nextStart = addDaysStr(today, 7)
    const res = await POST(makePostReq(makeUser('u-r12'), { from: nextStart }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.start, nextStart)
    assert.equal(body.end, addDaysStr(nextStart, 6))
  })

  it('#15 from = 過去 → 400「唔可以同步過去嘅日期」', async () => {
    const yesterday = addDaysStr(todayHK(), -1)
    const res = await POST(makePostReq(makeUser('u-r15'), { from: yesterday }))
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, '唔可以同步過去嘅日期')
  })

  it('#14 from > 今日+60 日 → 400「只可以同步未來 60 日內嘅資料」', async () => {
    const far = addDaysStr(todayHK(), 61)
    const res = await POST(makePostReq(makeUser('u-r14'), { from: far }))
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, '只可以同步未來 60 日內嘅資料')
  })

  it('from = 今日+60 日（邊界）→ 200', async () => {
    const edge = addDaysStr(todayHK(), 60)
    const res = await POST(makePostReq(makeUser('u-r14b'), { from: edge }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.start, edge)
  })

  it('from 格式壞 → 400', async () => {
    const res = await POST(makePostReq(makeUser('u-r400'), { from: '2026-8-5' }))
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /from 格式錯誤/)
  })

  it('無 body（舊前端／手撳）→ 200 默认窗口（今日起 7 日）', async () => {
    const today = todayHK()
    const res = await POST(makePostReq(makeUser('u-rnofrom')))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.start, today)
    assert.equal(body.end, addDaysStr(today, 6))
  })
})
