/**
 * ★ PL 標記 route 測試（2026-08-21）
 * 跑法: npx tsx --test src/lib/pl-mark-route.test.ts
 * （Node 22 內建 test runner）
 *
 * 覆蓋 MD §四 驗收：
 *   - 401 無 session
 *   - 403 冇 scheduling 權限（拍板④：scheduling 權限 gate）
 *   - 400 非 REST_DAY（拍板②：server 擋，防繞過前端直接 call API）
 *   - 200 同公司跨店（2026-08-21 拍板①：PL 唔限診所）
 *   - 403 跨公司（2026-08-21 拍板①補充：唔限診所但限公司 —— ownership guard）
 *   - 403 目標員工無主屬店／主屬店無公司（fail-closed）
 *   - 200 OWNER 任何公司（scope = null）
 *   - 200 無 UserClinic MANAGER fallback 自己公司（homeClinic → companyId）
 *   - 403 無 UserClinic 又無 employee record（fail-closed）
 *   - 404 搵唔到記錄
 *   - 200 正常標記（明文 value，唔係 client toggle）
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
  // MANAGER，有 UserClinic（c1 → compA）
  'u-manager': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [{ clinicId: 'c1' }],
  },
  // ★ MANAGER 無 UserClinic，但有 employee.homeClinicId=c1（fallback 場景）
  'u-manager-nou': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [],
  },
  // ★ MANAGER 無 UserClinic 又無 employee record（fail-closed 場景）
  'u-manager-nou-nemp': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [],
  },
  'u-owner': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [],
  },
  'u-employee': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [{ clinicId: 'c1' }],
  },
}

// ★ UserClinic 指派（resolveAccessibleCompanyIds 用）—— 無 UserClinic 嘅 MANAGER 回 []
const clinicLinksByUser: Record<string, Any[]> = {
  'u-manager': [{ clinic: { companyId: 'compA' } }],
  'u-manager-nou': [],
  'u-manager-nou-nemp': [],
  'u-owner': [],
  'u-employee': [],
}

// ★ Employee.homeClinicId（fallback 用）
const employeesByUser: Record<string, Any> = {
  'u-manager': { homeClinicId: 'c1' },
  'u-manager-nou': { homeClinicId: 'c1' },
  // u-manager-nou-nemp：無 employee record → null
}

// ★ Clinic → companyId（fallback 最後一步查呢度）
const clinicsById: Record<string, Any> = {
  c1: { companyId: 'compA' },
  c2: { companyId: 'compA' }, // c2 = 同公司另一間店（跨店場景）
}

let currentLr: Any = null
let updateCalls: Any[] = []

const fakes: Record<string, Any> = {
  user: { findUnique: async (args: Any) => users[args?.where?.id] ?? null },
  userClinic: {
    findMany: async (args: Any) => clinicLinksByUser[args?.where?.userId] ?? [],
  },
  employee: {
    findUnique: async (args: Any) => employeesByUser[args?.where?.userId] ?? null,
  },
  clinic: {
    findUnique: async (args: Any) => clinicsById[args?.where?.id] ?? null,
  },
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
const token = (userId: string, role: 'MANAGER' | 'OWNER' | 'EMPLOYEE') =>
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

/**
 * REST_DAY 記錄。@param targetCompany = 員工主屬店所屬公司（ownership 檢查對象）。
 * clinicId 只係記錄排咗邊間店嘅假（拍板①：唔限診所 → 唔入檢查）。
 */
const restDayLr = (targetCompany: string | null, isEmployeeRequested = false, clinicId = 'c1') => ({
  id: 'lr-test',
  clinicId,
  isEmployeeRequested,
  leaveType: { systemKey: 'REST_DAY' },
  employee: { homeClinic: targetCompany ? { companyId: targetCompany } : null },
})

const sickLr = () => ({
  id: 'lr-test',
  clinicId: 'c1',
  isEmployeeRequested: false,
  leaveType: { systemKey: 'SICK' },
})

describe('pl-mark route（2026-08-21）', () => {
  it('401 無 session', async () => {
    currentLr = restDayLr('compA')
    const res = await PATCH(makeReq(null, true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 401)
  })

  it('403 冇 scheduling 權限（EMPLOYEE 預設無）', async () => {
    currentLr = restDayLr('compA')
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

  it('200 同公司跨店（2026-08-21 拍板①：PL 唔限診所 —— 原本 403 改成功）', async () => {
    updateCalls = []
    // 假排喺 c2（另一間店），但員工主屬店仍係 compA
    currentLr = restDayLr('compA', false, 'c2')
    const res = await PATCH(makeReq(token('u-manager', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 200)
    assert.equal(updateCalls.length, 1, '同公司跨店都照標')
  })

  it('403 跨公司（2026-08-21 拍板①補充：限公司）', async () => {
    updateCalls = []
    // MANAGER 管 compA，目標員工主屬店係 compB
    currentLr = restDayLr('compB')
    const res = await PATCH(makeReq(token('u-manager', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 403)
    assert.equal(updateCalls.length, 0, '403 唔可以調 update')
  })

  it('403 目標員工無主屬店（fail-closed）', async () => {
    updateCalls = []
    currentLr = restDayLr(null)
    const res = await PATCH(makeReq(token('u-manager', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 403)
    assert.equal(updateCalls.length, 0)
  })

  it('200 OWNER 任何公司（scope = null 全放行）', async () => {
    updateCalls = []
    currentLr = restDayLr('compB')
    const res = await PATCH(makeReq(token('u-owner', 'OWNER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 200)
    assert.equal(updateCalls.length, 1)
  })

  it('200 無 UserClinic MANAGER fallback 自己公司（MD §2.3：homeClinic → companyId）', async () => {
    updateCalls = []
    // u-manager-nou：UserClinic 空 → fallback employee.homeClinicId=c1 → clinic c1 → compA
    currentLr = restDayLr('compA')
    const res = await PATCH(makeReq(token('u-manager-nou', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 200)
    assert.equal(updateCalls.length, 1, 'fallback 之後照標自己公司')
  })

  it('200 無 UserClinic MANAGER fallback 跨店（自己公司另一間店）', async () => {
    updateCalls = []
    currentLr = restDayLr('compA', false, 'c2')
    const res = await PATCH(makeReq(token('u-manager-nou', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 200)
    assert.equal(updateCalls.length, 1)
  })

  it('403 無 UserClinic MANAGER fallback 跨公司（fallback 只救自己公司）', async () => {
    updateCalls = []
    currentLr = restDayLr('compB')
    const res = await PATCH(makeReq(token('u-manager-nou', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 403)
    assert.equal(updateCalls.length, 0)
  })

  it('403 無 UserClinic 又無 employee record（fail-closed）', async () => {
    updateCalls = []
    currentLr = restDayLr('compA')
    const res = await PATCH(makeReq(token('u-manager-nou-nemp', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 403)
    assert.equal(updateCalls.length, 0)
  })

  it('200 正常標記（value=true）', async () => {
    updateCalls = []
    currentLr = restDayLr('compA', false)
    const res = await PATCH(makeReq(token('u-manager', 'MANAGER'), true), { params: { id: 'lr-test' } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.isEmployeeRequested, true)
    assert.equal(updateCalls.length, 1)
    assert.deepEqual(updateCalls[0].data, { isEmployeeRequested: true })
  })

  it('200 取消標記（value=false，明文目標值）', async () => {
    updateCalls = []
    currentLr = restDayLr('compA', true)
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
    currentLr = restDayLr('compA', true)
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
