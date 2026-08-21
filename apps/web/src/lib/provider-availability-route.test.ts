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
