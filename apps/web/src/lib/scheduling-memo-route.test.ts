/**
 * ★ SchedulingMemo route 測試（2026-08-21）
 * 跑法: npx tsx --test src/lib/scheduling-memo-route.test.ts
 * （Node 22 內建 test runner）
 *
 * 覆蓋驗收：
 *   - 401 無 session（GET/PUT）
 *   - 403 冇 scheduling 權限（EMPLOYEE 預設無）
 *   - 403 跨公司（MANAGER 只可以寫自己被指派診所所屬公司）
 *   - 400 periodMonth 格式唔係 YYYY-MM / 缺 companyId
 *   - 500 字上限（600 字入 → 只存 500）
 *   - 空白 = deleteMany（唔留空字串 row）
 *   - 200 upsert（create / update）
 *   - GET 有 row / 冇 row（text:''）/ 403 跨公司
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { prisma } from './prisma'
import { createToken } from './auth'
import { GET, PUT } from '../app/api/scheduling-memo/route'

// ---- fake prisma（唔真連 DB）------------------------------------------------
type Any = any
const users: Record<string, Any> = {
  'u-owner': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [{ clinicId: 'c1' }],
  },
  'u-manager': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [{ clinicId: 'c1' }],
  },
  'u-employee': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [{ clinicId: 'c1' }],
  },
}

// ★ MANAGER 被指派嘅診所 → 全部屬 compA（跨公司 = compB 應該 403）
const clinicLinksByUser: Record<string, Any[]> = {
  'u-owner': [],
  'u-manager': [{ clinic: { companyId: 'compA' } }],
  'u-employee': [{ clinic: { companyId: 'compA' } }],
}

const memos: Record<string, Any> = {}
const upsertCalls: Any[] = []
const deleteManyCalls: Any[] = []
const key = (companyId: string, periodMonth: string) => `${companyId}|${periodMonth}`

const fakes: Record<string, Any> = {
  user: { findUnique: async (args: Any) => users[args?.where?.id] ?? null },
  userClinic: {
    findMany: async (args: Any) => clinicLinksByUser[args?.where?.userId] ?? [],
  },
  schedulingMemo: {
    findUnique: async (args: Any) => {
      const k = key(args?.where?.companyId_periodMonth?.companyId, args?.where?.companyId_periodMonth?.periodMonth)
      const row = memos[k]
      return row ? { text: row.text, updatedAt: row.updatedAt } : null
    },
    upsert: async (args: Any) => {
      upsertCalls.push(args)
      const k = key(args?.where?.companyId_periodMonth?.companyId, args?.where?.companyId_periodMonth?.periodMonth)
      // ★ Prisma upsert 係 { update, create } 兩個 object，冇 data 欄
      const data = { ...args?.create, ...args?.update }
      memos[k] = {
        ...memos[k],
        ...data,
        updatedAt: new Date('2026-08-21T00:00:00Z'),
      }
      return { text: memos[k].text, updatedAt: memos[k].updatedAt }
    },
    deleteMany: async (args: Any) => {
      deleteManyCalls.push(args)
      delete memos[key(args?.where?.companyId, args?.where?.periodMonth)]
      return { count: 1 }
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
const token = (userId: string, role: 'OWNER' | 'MANAGER' | 'EMPLOYEE') =>
  createToken({ userId, role, clinics: ['c1'], tokenVersion: 1 })

const makeReq = (
  tok: string | null,
  method: 'GET' | 'PUT',
  body?: Any,
  query = 'companyId=compA&periodMonth=2026-08',
) =>
  new NextRequest(`http://localhost/api/scheduling-memo${query ? `?${query}` : ''}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { cookie: `session=${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

describe('scheduling-memo route（2026-08-21）', () => {
  it('GET 401 無 session', async () => {
    const res = await GET(makeReq(null, 'GET') as any)
    assert.equal(res.status, 401)
  })

  it('PUT 401 無 session', async () => {
    const res = await PUT(makeReq(null, 'PUT', { companyId: 'compA', periodMonth: '2026-08', text: 'x' }) as any)
    assert.equal(res.status, 401)
  })

  it('PUT 403 冇 scheduling 權限（EMPLOYEE 預設無）', async () => {
    const res = await PUT(makeReq(token('u-employee', 'EMPLOYEE'), 'PUT', { companyId: 'compA', periodMonth: '2026-08', text: 'x' }) as any)
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.match(body.error, /missing permission/i)
    assert.equal(upsertCalls.length, 0, '403 唔可以調 upsert')
  })

  it('PUT 403 跨公司（MANAGER 管 compA，寫 compB）', async () => {
    upsertCalls.length = 0
    const res = await PUT(makeReq(token('u-manager', 'MANAGER'), 'PUT', { companyId: 'compB', periodMonth: '2026-08', text: 'x' }) as any)
    assert.equal(res.status, 403)
    assert.equal(upsertCalls.length, 0, '403 唔可以調 upsert')
  })

  it('GET 403 跨公司（MANAGER 讀 compB）', async () => {
    const res = await GET(makeReq(token('u-manager', 'MANAGER'), 'GET', undefined, 'companyId=compB&periodMonth=2026-08') as any)
    assert.equal(res.status, 403)
  })

  it('PUT 400 periodMonth 格式唔啱', async () => {
    upsertCalls.length = 0
    for (const pm of ['2026-8', '20260831', '2026/08', '', null]) {
      const res = await PUT(makeReq(token('u-manager', 'MANAGER'), 'PUT', { companyId: 'compA', periodMonth: pm, text: 'x' }) as any)
      assert.equal(res.status, 400, `periodMonth=${String(pm)} 應該 400`)
    }
    assert.equal(upsertCalls.length, 0, '400 唔可以調 upsert')
  })

  it('PUT 400 缺 companyId', async () => {
    const res = await PUT(makeReq(token('u-manager', 'MANAGER'), 'PUT', { companyId: undefined, periodMonth: '2026-08', text: 'x' }) as any)
    assert.equal(res.status, 400)
  })

  it('PUT 500 字上限（600 字入 → 只存 500）', async () => {
    upsertCalls.length = 0
    const long = 'A'.repeat(600)
    const res = await PUT(makeReq(token('u-manager', 'MANAGER'), 'PUT', { companyId: 'compA', periodMonth: '2026-08', text: long }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.text.length, 500)
    assert.equal(upsertCalls.length, 1)
    assert.equal(upsertCalls[0].create.text.length, 500)
    assert.equal(upsertCalls[0].update.text.length, 500)
  })

  it('PUT 空白 = deleteMany（唔留空字串 row）', async () => {
    memos[key('compA', '2026-08')] = { text: '舊備註', updatedAt: new Date() }
    upsertCalls.length = 0
    deleteManyCalls.length = 0
    const res = await PUT(makeReq(token('u-manager', 'MANAGER'), 'PUT', { companyId: 'compA', periodMonth: '2026-08', text: '   ' }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.text, '')
    assert.equal(deleteManyCalls.length, 1)
    assert.deepEqual(deleteManyCalls[0].where, { companyId: 'compA', periodMonth: '2026-08' })
    assert.equal(upsertCalls.length, 0, '空白唔可以調 upsert')
    assert.equal(memos[key('compA', '2026-08')], undefined, 'row 應該刪咗')
  })

  it('PUT 200 upsert create', async () => {
    upsertCalls.length = 0
    const res = await PUT(makeReq(token('u-manager', 'MANAGER'), 'PUT', { companyId: 'compA', periodMonth: '2026-09', text: '九月備註' }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.text, '九月備註')
    assert.ok(body.updatedAt)
    assert.equal(upsertCalls.length, 1)
    assert.equal(upsertCalls[0].where.companyId_periodMonth.companyId, 'compA')
    assert.equal(upsertCalls[0].where.companyId_periodMonth.periodMonth, '2026-09')
  })

  it('PUT 200 upsert update（同一公司同一月覆寫）', async () => {
    upsertCalls.length = 0
    const res = await PUT(makeReq(token('u-manager', 'MANAGER'), 'PUT', { companyId: 'compA', periodMonth: '2026-09', text: '九月備註 v2' }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.text, '九月備註 v2')
    assert.equal(upsertCalls.length, 1)
  })

  it('PUT 200 OWNER 可以寫任何公司（compB）', async () => {
    upsertCalls.length = 0
    const res = await PUT(makeReq(token('u-owner', 'OWNER'), 'PUT', { companyId: 'compB', periodMonth: '2026-08', text: 'owner 備註' }) as any)
    assert.equal(res.status, 200)
    assert.equal(upsertCalls.length, 1)
  })

  it('GET 200 有 row → 回 text', async () => {
    const res = await GET(makeReq(token('u-manager', 'MANAGER'), 'GET', undefined, 'companyId=compA&periodMonth=2026-09') as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.text, '九月備註 v2')
  })

  it('GET 200 冇 row → text:""', async () => {
    const res = await GET(makeReq(token('u-manager', 'MANAGER'), 'GET', undefined, 'companyId=compA&periodMonth=2026-10') as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.text, '')
  })

  it('GET 參數缺失 → 按「冇備註」回（唔好 400 攞走整頁）', async () => {
    const res = await GET(makeReq(token('u-manager', 'MANAGER'), 'GET', undefined, 'companyId=compA') as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.text, '')
  })
})
