/**
 * ★ provider-availability GET route 測試（2026-08-21，cw-plown-20260821-a1）
 * 跑法: npx tsx --test src/lib/provider-availability-route.test.ts
 * （Node 22 內建 test runner）
 *
 * 覆蓋 bookingStatus -6 = 取消（2026-08-20 實測）顯示層 filter：
 *   - status=-6 嘅預約 → booked 陣列冇佢（唔畫 busy 塊）
 *   - weekBookings 計數排除 -6（「N 約」同畫面塊數一致）
 *   - 其他 status（0/4/102）原值照回（顯示層 filter 唔改語義）
 *   - sync.lastSyncAt 仍然用全部 rows（包括 -6）算 —— DB/sync 層零改動
 *   - 403 診所 scope（resolveProviderScheduleScope 仍然生效）
 *   - 404 診所唔存在
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { prisma } from './prisma'
import { createToken } from './auth'
import { GET } from '../app/api/provider-availability/route'

// ---- fake prisma（唔真連 DB）------------------------------------------------
type Any = any

const users: Record<string, Any> = {
  // MANAGER，employee.homeClinicId = c1（resolveProviderScheduleScope 主屬店）
  'u-manager': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [{ clinicId: 'c1' }],
  },
}

const FROM = '2026-08-20'

const fakes: Record<string, Any> = {
  user: { findUnique: async (args: Any) => users[args?.where?.id] ?? null },
  employee: {
    findUnique: async (args: Any) =>
      args?.where?.userId === 'u-manager' ? { homeClinicId: 'c1' } : null,
  },
  clinic: {
    findUnique: async (args: Any) =>
      args?.where?.id === 'c1' ? { id: 'c1', name: 'Test Clinic' }
        : args?.where?.id === 'c-other' ? { id: 'c-other', name: 'Other Clinic' }
          : null,
  },
  provider: {
    findMany: async () => [
      { id: 'pa', name: 'Dr A', color: '#FF0000' },
      { id: 'pb', name: 'Dr B', color: null },
    ],
  },
  providerAvailability: { findMany: async () => [] },
  providerBooking: {
    // ★ 4 筆：0（confirmed）、-6（取消，syncedAt 最新）、4（已完成）、102（改期）
    findMany: async () => [
      { providerId: 'pa', date: FROM, startMin: 540, endMin: 600, status: 0, syncedAt: new Date('2026-08-20T04:00:00Z') },
      { providerId: 'pa', date: FROM, startMin: 600, endMin: 660, status: -6, syncedAt: new Date('2026-08-20T06:00:00Z') },
      { providerId: 'pa', date: FROM, startMin: 840, endMin: 900, status: 4, syncedAt: new Date('2026-08-20T03:00:00Z') },
      { providerId: 'pa', date: FROM, startMin: 900, endMin: 960, status: 102, syncedAt: new Date('2026-08-20T02:00:00Z') },
    ],
  },
  providerLeave: { findMany: async () => [] },
  // ★ cw-patwl：三層疊新加載（pattern + 該日 shift 例外）
  providerWeeklyPattern: { findMany: async () => [] },
  providerShift: { findMany: async () => [] },
}

const saved: Record<string, Any> = {}
before(() => {
  for (const k of Object.keys(fakes)) {
    saved[k] = (prisma as Any)[k]
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})
after(() => {
  for (const k of Object.keys(saved)) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
})

// ---- 工具 --------------------------------------------------------------------
const makeReq = (query: string) =>
  new NextRequest(`http://localhost/api/provider-availability?${query}`, {
    method: 'GET',
    headers: { cookie: `session=${createToken({ userId: 'u-manager', role: 'MANAGER', clinics: ['c1'], tokenVersion: 1 })}` },
  })

describe('provider-availability route — -6 取消預約顯示 filter（2026-08-21）', () => {
  it('booked 陣列冇 -6（唔畫 busy 塊），其他 status 原值照回', async () => {
    const res = await GET(makeReq(`clinicId=c1&from=${FROM}`))
    assert.equal(res.status, 200)
    const body = await res.json()
    const pa = body.providers.find((p: Any) => p.id === 'pa')
    // 4 筆入 → 3 筆出（-6 被 filter 走）
    assert.equal(pa.booked.length, 3)
    const statuses = pa.booked.map((b: Any) => b.status).sort((a: number, b: number) => a - b)
    assert.deepEqual(statuses, [0, 4, 102])
    assert.ok(!pa.booked.some((b: Any) => b.status === -6), '-6 唔可以出現喺 booked')
  })

  it('weekBookings 計數排除 -6（同畫面塊數一致：4 筆入 → 3）', async () => {
    const res = await GET(makeReq(`clinicId=c1&from=${FROM}`))
    const body = await res.json()
    const pa = body.providers.find((p: Any) => p.id === 'pa')
    assert.equal(pa.weekBookings, 3)
    // 塊數同計數一致
    assert.equal(pa.booked.length, pa.weekBookings)
    // 冇 booking 嘅 provider → 0
    const pb = body.providers.find((p: Any) => p.id === 'pb')
    assert.equal(pb.weekBookings, 0)
  })

  it('sync.lastSyncAt 仍然用全部 rows 算（-6 row 都計入 → DB/sync 層零改動）', async () => {
    const res = await GET(makeReq(`clinicId=c1&from=${FROM}`))
    const body = await res.json()
    // -6 筆嘅 syncedAt（06:00Z）係最新 → lastSyncAt 應該係佢
    assert.equal(body.sync.lastSyncAt, '2026-08-20T06:00:00.000Z')
  })

  it('403 診所 scope（主屬店以外唔給看）', async () => {
    const res = await GET(makeReq(`clinicId=c-other&from=${FROM}`))
    assert.equal(res.status, 403)
  })

  it('404 診所唔存在', async () => {
    const res = await GET(makeReq(`clinicId=c-ghost&from=${FROM}`))
    assert.equal(res.status, 404)
  })

  it('400 缺 clinicId / from 格式錯', async () => {
    const r1 = await GET(makeReq('from=2026-08-20'))
    assert.equal(r1.status, 400)
    const r2 = await GET(makeReq('clinicId=c1&from=2026-8-20'))
    assert.equal(r2.status, 400)
  })
})

// ---- dayFlags：pattern 三層疊（2026-08-22，cw-patwl）----
// FROM = 2026-08-20 = 四（weekday 4；JS getDay 日=0）；窗口 08-20…08-26
describe('provider-availability route — dayFlags 三層疊（cw-patwl 2026-08-22）', () => {
  let savedPattern: Any
  let savedShift: Any
  let savedLeave: Any
  before(() => {
    savedPattern = fakes.providerWeeklyPattern.findMany
    savedShift = fakes.providerShift.findMany
    savedLeave = fakes.providerLeave.findMany
  })
  after(() => {
    fakes.providerWeeklyPattern.findMany = savedPattern
    fakes.providerShift.findMany = savedShift
    fakes.providerLeave.findMany = savedLeave
  })

  it('pattern 空 → 全部 hasPattern=false（★★#20 鐵律：未建 pattern 唔准全灰）', async () => {
    const res = await GET(makeReq(`clinicId=c1&from=${FROM}`))
    const body = await res.json()
    assert.ok(Array.isArray(body.dayFlags) && body.dayFlags.length === 7)
    assert.ok(body.dayFlags.every((f: Any) => f.hasPattern === false))
    assert.ok(body.dayFlags.every((f: Any) => f.onDutyCount === 0))
  })

  it('pattern 命中周四（weekday 4）→ onDutyCount=1，其他日 0', async () => {
    fakes.providerWeeklyPattern.findMany = async () => [
      { providerId: 'pa', weekday: 4, slot: 'FULL' }, // 2026-08-20 = 四（JS getDay：日=0…四=4）
    ]
    const res = await GET(makeReq(`clinicId=c1&from=${FROM}`))
    const body = await res.json()
    const thu = body.dayFlags.find((f: Any) => f.date === '2026-08-20')
    assert.equal(thu.hasPattern, true)
    assert.equal(thu.onDutyCount, 1)
    const fri = body.dayFlags.find((f: Any) => f.date === '2026-08-21')
    assert.equal(fri.hasPattern, true)
    assert.equal(fri.onDutyCount, 0)
  })

  it("shift slot='OFF' 覆蓋 pattern → onDutyCount=0（驗收 #12：OFF 唔計當值）", async () => {
    fakes.providerWeeklyPattern.findMany = async () => [
      { providerId: 'pa', weekday: 4, slot: 'FULL' },
    ]
    fakes.providerShift.findMany = async () => [
      { providerId: 'pa', date: new Date('2026-08-20T00:00:00+08:00'), slot: 'OFF' },
    ]
    const res = await GET(makeReq(`clinicId=c1&from=${FROM}`))
    const body = await res.json()
    const thu = body.dayFlags.find((f: Any) => f.date === '2026-08-20')
    assert.equal(thu.onDutyCount, 0)
  })

  it('shift slot=null（用時間）→ 加多一個當值醫生', async () => {
    fakes.providerWeeklyPattern.findMany = async () => [
      { providerId: 'pa', weekday: 4, slot: 'FULL' },
    ]
    fakes.providerShift.findMany = async () => [
      { providerId: 'pb', date: new Date('2026-08-20T00:00:00+08:00'), slot: null },
    ]
    const res = await GET(makeReq(`clinicId=c1&from=${FROM}`))
    const body = await res.json()
    const thu = body.dayFlags.find((f: Any) => f.date === '2026-08-20')
    assert.equal(thu.onDutyCount, 2)
  })

  it('leave 蓋走 pattern → onDutyCount=0（驗收 #11）', async () => {
    fakes.providerWeeklyPattern.findMany = async () => [
      { providerId: 'pa', weekday: 4, slot: 'FULL' },
    ]
    fakes.providerShift.findMany = async () => []
    fakes.providerLeave.findMany = async () => [
      { providerId: 'pa', startDate: new Date('2026-08-20T00:00:00+08:00'), endDate: new Date('2026-08-26T00:00:00+08:00') },
    ]
    const res = await GET(makeReq(`clinicId=c1&from=${FROM}`))
    const body = await res.json()
    const thu = body.dayFlags.find((f: Any) => f.date === '2026-08-20')
    assert.equal(thu.onDutyCount, 0)
  })
})
