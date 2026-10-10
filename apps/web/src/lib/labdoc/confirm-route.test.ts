/**
 * cwm-labdoc P3 — §8.4 confirm route unit（fake prisma）
 *
 * 覆蓋：
 *  - 全行已解決＋§5.5 讀數 OK → CONFIRMED；全段 CONFIRMED → doc RECONCILED；audit LAB_STATEMENT_RECONCILE
 *  - 未處理行 → 400 unresolvedCount
 *  - §5.5 Σ 唔等 → 400 difference；statedTotal null → 400
 *  - OUTSTANDING：Σ CURRENT = statedCurrent
 *  - 已 CONFIRMED → 409；非月結單 → 400；SUPERSEDED → 409
 *  - 403（lab_invoice only）；404 IDOR
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { NextRequest } from 'next/server'
import { createRequire } from 'node:module'

const req2 = createRequire(import.meta.url)
const jwt: any = req2('jsonwebtoken')

const OWNER = 'f'.repeat(25)
const INV_ONLY = 'i'.repeat(25)
const DOC_ID = 'a'.repeat(25)
const SEC_ID = 'b'.repeat(25)
const SEC2_ID = 'h'.repeat(25)
const CLINIC = 'k'.repeat(25)
const PROVIDER = 'p'.repeat(25)
const LAB = 'l'.repeat(25)

process.env.JWT_SECRET = process.env.JWT_SECRET || 'p3-confirm-test-secret-0123456789'

function tokenFor(userId: string, role: string, grant: string[] = []): string {
  return jwt.sign({ userId, role, clinics: [], tokenVersion: 0, permissionsJson: { grant } }, process.env.JWT_SECRET, { expiresIn: '1h' })
}
function makeReq(tok: string, path: string): NextRequest {
  return new NextRequest(`http://x${path}`, { method: 'POST', headers: { cookie: `session=${tok}`, 'content-type': 'application/json' }, body: '{}' })
}

interface St {
  doc: any
  sections: any[] // include lines
  profile: any
  audits: any[]
  docUpdates: any[]
}

function mkLine(over: Record<string, unknown> = {}) {
  return {
    id: 'x'.repeat(25),
    sectionId: SEC_ID,
    lineIndex: 0,
    lineType: 'INVOICE',
    date: new Date('2026-09-10T00:00:00Z'),
    amount: 100,
    agingBucket: null,
    matchedDocumentId: null,
    matchedLineId: null,
    matchBasis: null,
    result: 'MATCHED',
    resolution: null,
    ...over,
  }
}

function mkState(over: Partial<St> = {}): St {
  const base: St = {
    doc: { id: DOC_ID, kind: 'STATEMENT', status: 'IN_PROGRESS', statementMonth: '2026-09', labId: LAB, clinicId: CLINIC, providerId: PROVIDER },
    sections: [
      {
        id: SEC_ID,
        documentId: DOC_ID,
        sectionIndex: 0,
        clinicId: CLINIC,
        providerId: PROVIDER,
        statedTotal: 250,
        statedCurrent: null,
        systemTotal: 250,
        status: 'OK',
        resultJson: { counts: { MATCHED: 3 }, runAt: '2026-10-01T00:00:00Z' },
        lines: [mkLine(), mkLine({ lineIndex: 1, amount: 100 }), mkLine({ lineIndex: 2, lineType: 'CREDIT', amount: 50 })],
      },
    ],
    profile: { labId: LAB, statementKind: 'INVOICE_LIST', statementDocNoSameAsInvoice: true },
    audits: [],
    docUpdates: [],
  }
  return { ...base, ...over }
}

function makeFake(state: St) {
  return {
    user: {
      findUnique: async ({ where }: any) =>
        where.id === OWNER
          ? { id: OWNER, name: 'Boss', role: 'OWNER', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [], permissionsJson: null }
          : where.id === INV_ONLY
            ? { id: INV_ONLY, name: 'InvOnly', role: 'EMPLOYEE', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [], permissionsJson: { grant: ['lab_invoice'] } }
            : null,
    },
    labProfile: { findUnique: async ({ where }: any) => (where.labId === state.profile.labId ? { ...state.profile } : null) },
    labDocument: {
      findUnique: async () => ({ ...state.doc }),
      update: async ({ data }: any) => {
        state.docUpdates.push(data)
        Object.assign(state.doc, data)
        return { ok: true }
      },
    },
    labStatementSection: {
      findFirst: async ({ where }: any) => {
        const s = state.sections.find((x) => x.id === where.id && x.documentId === where.documentId)
        return s ? { ...s } : null
      },
      findMany: async () => state.sections.map((s) => ({ status: s.status })),
      updateMany: async ({ where, data }: any) => {
        const s = state.sections.find((x) => x.id === where.id)
        if (!s || s.documentId !== where.documentId || s.status === where.status) return { count: 0 }
        if (where.status && where.status.not && s.status === where.status.not) return { count: 0 }
        Object.assign(s, data)
        return { count: 1 }
      },
    },
    auditLog: { create: async (a: any) => state.audits.push(a.data) },
    $transaction: async (fn: any) => fn(makeFake(state)),
  }
}

const KEYS = ['user', 'labProfile', 'labDocument', 'labStatementSection', 'auditLog', '$transaction'] as const
import { prisma } from '../prisma'
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]

let POST: any
before(async () => {
  const mod = await import('../../app/api/lab-docs/[id]/sections/[sid]/confirm/route')
  POST = mod.POST
})

function reset(state: St) {
  const fake = makeFake(state)
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
}
after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

const PATH = `/api/lab-docs/${DOC_ID}/sections/${SEC_ID}/confirm`

test('全行 MATCHED＋讀數 OK → CONFIRMED、全段 → doc RECONCILED、audit', async () => {
  const st = mkState()
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.status, 'CONFIRMED')
  assert.strictEqual(body.documentStatus, 'RECONCILED')
  assert.strictEqual(st.sections[0].status, 'CONFIRMED')
  assert.strictEqual(st.sections[0].confirmedBy, OWNER)
  assert.strictEqual(st.doc.status, 'RECONCILED')
  const a = st.audits.find((x) => x.action === 'LAB_STATEMENT_RECONCILE')
  assert.ok(a)
  const afterJson = JSON.parse(a.afterJson)
  assert.strictEqual(afterJson.statedTotal, 250)
  assert.strictEqual(afterJson.systemTotal, 250)
  assert.strictEqual(afterJson.totalDiff, 0)
})

test('未處理行（AMOUNT_DIFF 無 resolution）→ 400 unresolvedCount', async () => {
  const st = mkState()
  st.sections[0].lines[0] = mkLine({ result: 'AMOUNT_DIFF' })
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 400)
  const body = await r.json()
  assert.strictEqual(body.unresolvedCount, 1)
  assert.strictEqual(st.sections[0].status, 'OK', '未改')
})

test('AMOUNT_DIFF 但已 INVOICE_WINS → 放行（resolution 就算已處理）', async () => {
  const st = mkState()
  st.sections[0].lines[0] = mkLine({ result: 'AMOUNT_DIFF', resolution: 'INVOICE_WINS' })
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 200)
})

test('§5.5 Σ 唔等 → 400 difference', async () => {
  const st = mkState()
  st.sections[0].lines[2].amount = 60 // Σ = 260 vs 250
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 400)
  const body = await r.json()
  assert.strictEqual(body.difference, 10)
})

test('statedTotal null → 400', async () => {
  const st = mkState({ sections: [{ ...mkState().sections[0], statedTotal: null }] })
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 400)
})

test('OUTSTANDING：Σ CURRENT = statedCurrent → 200', async () => {
  const st = mkState({
    profile: { labId: LAB, statementKind: 'OUTSTANDING', statementDocNoSameAsInvoice: true },
    sections: [
      {
        ...mkState().sections[0],
        statedTotal: 1561,
        statedCurrent: 1061,
        lines: [
          mkLine({ amount: 1061, agingBucket: 'CURRENT' }),
          mkLine({ lineIndex: 1, amount: 500, agingBucket: 'D31_90' }),
          mkLine({ lineIndex: 2, lineType: 'CHARGE', amount: 0, agingBucket: null }),
        ],
      },
    ],
  })
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 200)
})

test('已 CONFIRMED → 409', async () => {
  const st = mkState({ sections: [{ ...mkState().sections[0], status: 'CONFIRMED' }] })
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 409)
})

test('兩個分段：第一支 → doc 未 RECONCILED；第二支 → RECONCILED', async () => {
  const sec2 = { ...mkState().sections[0], id: SEC2_ID, sectionIndex: 1, statedTotal: 100, lines: [mkLine({ sectionId: SEC2_ID, amount: 100 })] }
  const st = mkState({ sections: [mkState().sections[0], sec2] })
  reset(st)
  let r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), `/api/lab-docs/${DOC_ID}/sections/${SEC_ID}/confirm`) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(st.doc.status, 'IN_PROGRESS', '未完全部）')
  r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), `/api/lab-docs/${DOC_ID}/sections/${SEC2_ID}/confirm`) as any, { params: { id: DOC_ID, sid: SEC2_ID } } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.documentStatus, 'RECONCILED')
  assert.strictEqual(st.doc.status, 'RECONCILED')
})

test('非月結單 → 400；SUPERSEDED → 409', async () => {
  const st = mkState({ doc: { ...mkState().doc, kind: 'INVOICE' } })
  reset(st)
  let r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 400)
  const st2 = mkState({ doc: { ...mkState().doc, status: 'SUPERSEDED' } })
  reset(st2)
  r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 409)
})

test('T11 口徑：lab_invoice only → 403', async () => {
  const st = mkState()
  reset(st)
  const r = await POST(makeReq(tokenFor(INV_ONLY, 'EMPLOYEE', ['lab_invoice']), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 403)
})

test('IDOR：section 唔屬於呢張單 → 404', async () => {
  const st = mkState()
  st.sections[0].documentId = 'z'.repeat(25)
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), PATH) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 404)
})
