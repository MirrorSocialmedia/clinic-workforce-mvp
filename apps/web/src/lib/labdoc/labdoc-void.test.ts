/**
 * cwm-labdoc P2 — §7.10 作廢 invoice route unit
 *
 * 覆蓋：
 *  - 200：VOID＋voidReason＋audit LAB_DOC_VOID＋version+1
 *  - 400：reason 缺失／>200；已 VOID
 *  - 409：有 MATCHED 行（要先解除配對／作廢成本）
 *  - 404：唔存在；401 無 token；403 EMPLOYEE
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { NextRequest } from 'next/server'
import { createRequire } from 'node:module'

const req2 = createRequire(import.meta.url)
const jwt: any = req2('jsonwebtoken')

const OWNER = 'f'.repeat(25)
const EMPLOYEE = 'e'.repeat(25)
const DOC_ID = 'a'.repeat(25)

process.env.JWT_SECRET = process.env.JWT_SECRET || 'p2-void-test-secret-0123456789-abcd'

function tokenFor(userId: string, role: string): string {
  return jwt.sign({ userId, role, clinics: [], tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })
}
function makeReq(tok: string | null, body: unknown): NextRequest {
  return new NextRequest(`http://x/api/lab-docs/${DOC_ID}`, {
    method: 'DELETE',
    headers: tok ? { cookie: `session=${tok}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

import { prisma } from '../prisma'

interface State {
  doc: any
  matchedCount: number
  audits: any[]
}

function mkDoc(over: Record<string, unknown> = {}): any {
  return {
    id: DOC_ID,
    kind: 'INVOICE',
    status: 'CONFIRMED',
    version: 3,
    labId: null,
    clinicId: 'k'.repeat(25),
    docNo: 'INV-1',
    voidReason: null,
    voidedBy: null,
    voidedAt: null,
    ...over,
  }
}

function makeFake(state: State) {
  return {
    user: {
      findUnique: async ({ where }: any) =>
        where.id === OWNER
          ? { id: OWNER, name: 'Boss', role: 'OWNER', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [] }
          : where.id === EMPLOYEE
            ? { id: EMPLOYEE, name: 'Emp', role: 'EMPLOYEE', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [] }
            : null,
    },
    labDocument: {
      findUnique: async ({ where }: any) => (where.id === state.doc.id ? { ...state.doc } : null),
      update: async ({ where, data }: any) => {
        if (where.id !== state.doc.id) throw new Error('no doc')
        const d = { ...data }
        if (d.version?.increment) {
          state.doc.version = (state.doc.version ?? 0) + d.version.increment
          delete d.version
        }
        Object.assign(state.doc, d)
        return { ...state.doc }
      },
    },
    labDocumentLine: {
      count: async () => state.matchedCount,
    },
    auditLog: { create: async (a: any) => state.audits.push(a.data) },
    $transaction: async (fn: any) => fn(makeFake(state)),
  }
}

const KEYS = ['user', 'labDocument', 'labDocumentLine', 'auditLog', '$transaction'] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]
after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

let DELETE: any
before(async () => {
  const mod = await import('../../app/api/lab-docs/[id]/route')
  DELETE = mod.DELETE
})

function reset(state: State) {
  const fake = makeFake(state)
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
}

test('§7.10 200：VOID＋reason＋audit＋version+1', async () => {
  const state: State = { doc: mkDoc(), matchedCount: 0, audits: [] }
  reset(state)
  const r = await DELETE(makeReq(tokenFor(OWNER, 'OWNER'), { reason: '上傳錯檔案' }) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.document.status, 'VOID')
  assert.strictEqual(body.document.version, 4)
  assert.strictEqual(state.doc.status, 'VOID')
  assert.strictEqual(state.doc.voidReason, '上傳錯檔案')
  assert.strictEqual(state.doc.voidedBy, OWNER)
  const audit = state.audits.find((a) => a.action === 'LAB_DOC_VOID')
  assert.ok(audit)
  assert.strictEqual(audit.entityId, DOC_ID)
})

test('§7.10 400 家族', async () => {
  const mk = (over: Record<string, unknown> = {}) => ({ doc: mkDoc(over), matchedCount: 0, audits: [] as any[] })

  reset(mk())
  assert.strictEqual((await DELETE(makeReq(tokenFor(OWNER, 'OWNER'), {}) as any, { params: { id: DOC_ID } } as any)).status, 400) // 無 reason
  assert.strictEqual((await DELETE(makeReq(tokenFor(OWNER, 'OWNER'), { reason: 'x'.repeat(201) }) as any, { params: { id: DOC_ID } } as any)).status, 400)

  reset(mk({ status: 'VOID' }))
  assert.strictEqual((await DELETE(makeReq(tokenFor(OWNER, 'OWNER'), { reason: '再作廢' }) as any, { params: { id: DOC_ID } } as any)).status, 400)

  const stmtState = mk({ kind: 'STATEMENT' })
  reset(stmtState)
  // P3 §11：月結單作廢 = lab_statement（OWNER 有）→ 200
  const rStmt = await DELETE(makeReq(tokenFor(OWNER, 'OWNER'), { reason: '作廢月結單' }) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(rStmt.status, 200)
  assert.strictEqual(stmtState.doc.status, 'VOID')
  assert.strictEqual(stmtState.doc.voidReason, '作廢月結單')
})

test('§7.10 409：有 MATCHED 行', async () => {
  const state: State = { doc: mkDoc(), matchedCount: 2, audits: [] }
  reset(state)
  const r = await DELETE(makeReq(tokenFor(OWNER, 'OWNER'), { reason: '想作廢' }) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 409)
  assert.strictEqual(state.doc.status, 'CONFIRMED', '未改動')
})

test('§7.10 auth：404 唔存在；401 無 token；403 EMPLOYEE', async () => {
  const state: State = { doc: mkDoc({ id: 'z'.repeat(25) }), matchedCount: 0, audits: [] }
  reset(state)
  assert.strictEqual((await DELETE(makeReq(tokenFor(OWNER, 'OWNER'), { reason: 'x' }) as any, { params: { id: DOC_ID } } as any)).status, 404)
  assert.strictEqual((await DELETE(makeReq(null, { reason: 'x' }) as any, { params: { id: DOC_ID } } as any)).status, 401)

  reset({ doc: mkDoc(), matchedCount: 0, audits: [] })
  assert.strictEqual((await DELETE(makeReq(tokenFor(EMPLOYEE, 'EMPLOYEE'), { reason: 'x' }) as any, { params: { id: DOC_ID } } as any)).status, 403)
})
