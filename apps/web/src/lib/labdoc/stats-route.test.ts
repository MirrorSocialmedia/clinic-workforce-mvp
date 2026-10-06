/**
 * cwm-labdoc P4 CHUNK 3 — GET /api/lab-docs/stats unit（§11 容量統計）
 *
 * 覆蓋：
 *  - 200：聚合回傳（totalBytes = 未 purge LabFile size 總和；statusCounts = LabDocument groupBy）
 *  - RBAC：401 無 token；403 無 grant；403 只有 lab_invoice（stats = lab_statement 專屬 — 工單明確）
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { NextRequest } from 'next/server'
import { createToken } from '../auth'

const OWNER = 'f'.repeat(25)
const EMP = 'e'.repeat(25) // + grant lab_statement
const EMP_INV = 'i'.repeat(25) // + grant 只有 lab_invoice
const NOPE = 'n'.repeat(25) // 無 grant

const FILES = [
  { sizeBytes: 1_000_000, purgedAt: null },
  { sizeBytes: 2_000_000, purgedAt: null },
  { sizeBytes: 999_999, purgedAt: new Date('2026-01-01T00:00:00Z') }, // purged — 唔計
]
const STATUS_GROUPS = [
  { status: 'CONFIRMED', _count: { _all: 40 } },
  { status: 'NEEDS_REVIEW', _count: { _all: 3 } },
  { status: 'VOID', _count: { _all: 2 } },
]

function makeFakePrisma() {
  return {
    user: {
      findUnique: async ({ where }: any) => {
        if (where.id === OWNER)
          return { id: OWNER, name: 'Boss', role: 'OWNER', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [], permissionsJson: null }
        if (where.id === EMP)
          return { id: EMP, name: 'EmpStmt', role: 'EMPLOYEE', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [], permissionsJson: JSON.stringify({ grant: ['lab_statement'], deny: [] }) }
        if (where.id === EMP_INV)
          return { id: EMP_INV, name: 'EmpInv', role: 'EMPLOYEE', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [], permissionsJson: JSON.stringify({ grant: ['lab_invoice'], deny: [] }) }
        if (where.id === NOPE)
          return { id: NOPE, name: 'NoPerm', role: 'EMPLOYEE', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [], permissionsJson: null }
        return null
      },
    },
    labFile: {
      // fake：where.purgedAt === null → 只數未 purge
      aggregate: async ({ where }: any) => {
        const live = where?.purgedAt === null ? FILES.filter((f) => f.purgedAt === null) : FILES
        return {
          _sum: { sizeBytes: live.reduce((a, f) => a + f.sizeBytes, 0) },
          _count: { _all: live.length },
        }
      },
    },
    labDocument: {
      groupBy: async () => STATUS_GROUPS,
    },
  }
}

let GET: any
import { prisma } from '../prisma'

const KEYS = ['user', 'labFile', 'labDocument'] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]

function installFake() {
  const fake = makeFakePrisma()
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
}

function tok(userId: string, role: 'OWNER' | 'EMPLOYEE' = 'EMPLOYEE') {
  return createToken({ userId, role, clinics: [], tokenVersion: 0 })
}

function makeReq(token: string | null): NextRequest {
  return new NextRequest('http://x/api/lab-docs/stats', {
    method: 'GET',
    headers: token ? { cookie: `session=${token}` } : {},
  })
}

before(async () => {
  const mod = await import('../../app/api/lab-docs/stats/route')
  GET = mod.GET
  installFake()
})

after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

test('200：聚合（purged 檔唔計；statusCounts 全狀態；docCount = 總和）', async () => {
  const r = await GET(makeReq(tok(OWNER, 'OWNER')))
  assert.strictEqual(r.status, 200)
  const d = await r.json()
  assert.strictEqual(d.totalBytes, 3_000_000) // 1M + 2M（999999 purged 唔計）
  assert.strictEqual(d.fileCount, 2)
  assert.strictEqual(d.docCount, 45)
  assert.deepStrictEqual(d.statusCounts, { CONFIRMED: 40, NEEDS_REVIEW: 3, VOID: 2 })
})

test('RBAC：401 無 token；403 無 grant；403 只有 lab_invoice', async () => {
  assert.strictEqual((await GET(makeReq(null))).status, 401)
  assert.strictEqual((await GET(makeReq(tok(NOPE)))).status, 403)
  assert.strictEqual((await GET(makeReq(tok(EMP_INV)))).status, 403)
  // 對照：lab_statement 放行
  assert.strictEqual((await GET(makeReq(tok(EMP)))).status, 200)
})
