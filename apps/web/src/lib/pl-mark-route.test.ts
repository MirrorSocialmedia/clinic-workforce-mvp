/**
 * ★ PL 標記 route 測試（2026-08-21）
 * 跑法: npx tsx --test src/lib/pl-mark-route.test.ts
 * （Node 22 內建 test runner）
 *
 * 覆蓋 MD §五 驗收：
 *   - 401 無 session
 *   - 403 冇 scheduling 權限（拍板④：scheduling 權限 gate）
 *   - 400 非 REST_DAY（拍板②：server 擋，防繞過前端直接 call API）
 *   - 403 跨店（resolveProviderScheduleScope + inScope）
 *   - 404 搵唔到記錄
 *   - 200 正常 toggle（明文 value，唔係 client toggle）
 *   - 400/403/404 一律唔會調 update（零下游影響 —— DB 層面前無副作用）
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { prisma } from './prisma'
import { createToken } from './auth'
import { PATCH } from '../app/api/leave-requests/[id]/pl-mark/route'

// ---- fake prisma（唔真連 DB）------------------------------------------------
type Any = any
const users: Record<string, Any> = {
  'u-manager': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [{ clinicId: 'c1' }],
  },
  'u-employee': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [{ clinicId: 'c1' }],
  },
}

let currentLr: Any = null
let updateCalls: Any[] = []

const fakes: Record<string, Any> = {
  user: { findUnique: async (args: Any) => users[args?.where?.id] ?? null },
  // MANAGER 主屬店 = c1（resolveProviderScheduleScope → [homeClinicId]）
  employee: { findUnique: async () => ({ homeClinicId: 'c1' }) },
  leaveRequest: {
    findUnique: async () => currentLr,
    update: async (args: Any) => {
      updateCalls.push(args)
      return { id: 'lr-test', isEmployeeRequested: args?.data?.isEmployeeRequested ?? false }
    },
  },
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
const token = (userId: string, role: 'MANAGER' | 'EMPLOYEE') =>
  createToken({ userId, role, clinics: ['c1'], tokenVersion: 1 })

const makeReq = (tok: string | null, value: boolean) =>
  new NextRequest('http://localhost/api/leave-requests/lr-test/pl-mark', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(tok ? { cookie: `session=${tok}` } : {}),
    },
    body: JSON.stringify({ value }),
  })

const restDayLr = (clinicId: string, isEmployeeRequested = false) => ({
  id: 'lr-test',
  clinicId,
  isEmployeeRequested,
  leaveType: { systemKey: 'REST_DAY' },
  employee: { homeClinicId: 'c1' },
})

const sickLr = () => ({
  id: 'lr-test',
  clinicId: 'c1',
  isEmployeeRequested: false,
  leaveType: { systemKey: 'SICK' },
  employee: { homeClinicId: 'c1' },
})

describe('pl-mark route（2026-08-21）', () => {
  it('401 無 session', async () => {
    currentLr = restDayLr('c1')
    const res = await PATCH(makeReq(null, true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 401)
  })

  it('403 冇 scheduling 權限（EMPLOYEE 預設無）', async () => {
    currentLr = restDayLr('c1')
    const res = await PATCH(makeReq(token('u-employee', 'EMPLOYEE'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.match(body.error, /missing permission/i)
  })

  it('404 搵唔到假期記錄', async () => {
    currentLr = null
    const res = await PATCH(makeReq(token('u-manager', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 404)
    assert.equal(updateCalls.length, 0)
  })

  it('400 非 REST_DAY（拍板②：server 擋）', async () => {
    updateCalls = []
    currentLr = sickLr()
    const res = await PATCH(makeReq(token('u-manager', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /休息日/)
    assert.equal(updateCalls.length, 0, '400 唔可以調 update')
  })

  it('403 跨店（MANAGER 主屬店 c1，假期喺 c2）', async () => {
    updateCalls = []
    currentLr = restDayLr('c2')
    const res = await PATCH(makeReq(token('u-manager', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 403)
    assert.equal(updateCalls.length, 0, '403 唔可以調 update')
  })

  it('200 正常標記（value=true）', async () => {
    updateCalls = []
    currentLr = restDayLr('c1', false)
    const res = await PATCH(makeReq(token('u-manager', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.isEmployeeRequested, true)
    assert.equal(updateCalls.length, 1)
    assert.deepEqual(updateCalls[0].data, { isEmployeeRequested: true })
  })

  it('200 取消標記（value=false，明文目標值）', async () => {
    updateCalls = []
    currentLr = restDayLr('c1', true)
    const res = await PATCH(makeReq(token('u-manager', 'MANAGER'), false), { params: { id: 'lr-test' } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.isEmployeeRequested, false)
    assert.equal(updateCalls.length, 1)
    assert.deepEqual(updateCalls[0].data, { isEmployeeRequested: false })
  })

  it('200 body 缺 value → 按 value!==true 收 false（拍板：明文目標值，唔係 toggle）', async () => {
    // 拍板：server 永遠收目標值。body 缺 value → next=false（等同取消標記）。
    updateCalls = []
    currentLr = restDayLr('c1', true)
    const res = await PATCH(
      new NextRequest('http://localhost/api/leave-requests/lr-test/pl-mark', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: `session=${token('u-manager', 'MANAGER')}` },
        body: JSON.stringify({}),
      }),
      { params: { id: 'lr-test' } },
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.isEmployeeRequested, false)
  })
})
