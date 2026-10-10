/**
 * cwm-labdoc P2 — §13 改舊 code（cost-cases route）unit
 *
 * 覆蓋（§15.2 + T13 + T3 相鄰）：
 *  - PUT B4：labInvoiceLinked=true → 唔套月度折扣（冇傳 labId / 有傳 labId 都 finalCost = baseCost）、
 *    discountPct 欄明確寫 null（清舊快照）
 *  - PUT 回歸：labInvoiceLinked=false → 折扣照常
 *  - PUT §13：patientCode／clinicId 改 → patientCodeNorm 重算（用新診所 shortName）
 *  - PUT 並發：updateMany(lockedByRunId null) 0 行 → 409（零寫入、零 audit）
 *  - DELETE（T13）：作廢已連 invoice 嘅成本 → MATCHED 行 UNMATCHED（costCaseId/linkType 清）、
 *    文件狀態重算（RECONCILED → PARTIAL）、audit LAB_DOC_LINE_UNMATCH（單一來源 helper，notes「作廢成本」）+ COST_CASE_VOID；
 *    無配對行 → 淨 void；已鎖 → 409；已 VOID → 409
 *  - POST §13（F-26）：目標月（醫生×診所×月）PayoutRun 已 LOCKED → 409＋零寫入；
 *    未鎖 → 201＋patientCodeNorm 寫入
 *  - recompute §13（B4）：labInvoiceLinked=true 嘅成本唔入重算（唔套折扣）
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { NextRequest } from 'next/server'
import { createRequire } from 'node:module'

const req2 = createRequire(import.meta.url)
const jwt: any = req2('jsonwebtoken')

const OWNER = 'f'.repeat(25)
const CLINIC_1 = 'k'.repeat(25)
const CLINIC_2 = 'h'.repeat(25)
const PROV_1 = 'p'.repeat(25)
const LAB_1 = 'i'.repeat(25)
const CC = 'c'.repeat(25)
const CC_OTHER = 'd'.repeat(25)
const DOC = 'a'.repeat(25)
const L1 = 'l'.repeat(25)
const L2 = 'm'.repeat(25)

process.env.JWT_SECRET = process.env.JWT_SECRET || 'p2-costcases-labdoc-test-secret-0123456'

function tokenFor(): string {
  return jwt.sign({ userId: OWNER, role: 'OWNER', clinics: [], tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })
}
function dec(v: number): any {
  return { v, toNumber: () => v }
}

interface CostState {
  [id: string]: any
}
interface State {
  costs: CostState
  docs: Record<string, any>
  lines: any[]
  audits: any[]
  discount: any | null
  lockedRun: boolean
  updateManyCount: number
  created: any[]
}

function baseCost(ccId: string, over: Record<string, any> = {}): any {
  return {
    id: ccId,
    clinicId: CLINIC_1,
    providerId: PROV_1,
    category: 'LAB',
    patientCode: 'TW007159',
    patientCodeNorm: 'TW007159',
    status: 'PRICED',
    lockedByRunId: null,
    baseCost: 500,
    finalCost: dec(457.5),
    discountPct: 8.5,
    labId: LAB_1,
    labInvoiceLinked: true,
    orderedAt: new Date('2026-09-01T00:00:00Z'),
    receivedAt: new Date('2026-09-15T00:00:00Z'),
    periodMonth: '2026-09',
    materials: [],
    note: null,
    redoAt: null,
    redoReason: null,
    ...over,
  }
}

function makeFake(state: State) {
  const costRow = (id: string) => {
    const c = state.costs[id]
    return c ? { ...c } : null
  }
  return {
    user: {
      findUnique: async ({ where, select }: any) =>
        where.id === OWNER
          ? select
            ? { tokenVersion: 0, status: 'ACTIVE', clinics: [] }
            : { id: OWNER, name: 'Boss', role: 'OWNER', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [] }
          : null,
    },
    clinic: {
      findUnique: async ({ where }: any) =>
        where.id === CLINIC_1
          ? { id: CLINIC_1, name: '大圍', shortName: 'TW' }
          : where.id === CLINIC_2
            ? { id: CLINIC_2, name: '土瓜灣', shortName: 'TKW' }
            : null,
      count: async ({ where }: any) => (where.id === CLINIC_1 || where.id === CLINIC_2 ? 1 : 0),
    },
    provider: {
      count: async ({ where }: any) => (where.id === PROV_1 ? 1 : 0),
    },
    labMonthlyDiscount: {
      findUnique: async () => state.discount,
      findFirst: async () => state.discount,
    },
    payoutRun: {
      findFirst: async ({ where }: any) =>
        state.lockedRun && where.status === 'LOCKED'
          ? { id: 'r'.repeat(25), periodMonth: where.periodMonth, status: 'LOCKED' }
          : null,
    },
    costCase: {
      findUnique: async ({ where, include }: any) => {
        const c = costRow(where.id)
        if (!c) return null
        return include ? { ...c, materials: [], lab: c.labId ? { id: c.labId, name: 'Lab' } : null } : { ...c }
      },
      findMany: async ({ where }: any) =>
        Object.values(state.costs).filter(
          (c: any) =>
            (where.labId ? c.labId === where.labId : true) &&
            (where.periodMonth ? c.periodMonth === where.periodMonth : true) &&
            (where.category?.in ? where.category.in.includes(c.category) : true) &&
            (where.lockedByRunId !== undefined ? (where.lockedByRunId === null ? c.lockedByRunId === null : c.lockedByRunId === where.lockedByRunId) : true) &&
            (where.labInvoiceLinked !== undefined ? c.labInvoiceLinked === where.labInvoiceLinked : true) &&
            (where.status?.not ? c.status !== where.status.not : true) &&
            (where.baseCost?.not !== undefined ? (where.baseCost.not === null ? c.baseCost != null : true) : true),
        ),
      updateMany: async ({ where, data }: any) => {
        const c = state.costs[where.id]
        if (!c) return { count: 0 }
        if (where.lockedByRunId !== undefined && where.lockedByRunId !== c.lockedByRunId) return { count: 0 }
        if (state.updateManyCount === 0) return { count: 0 }
        state.updateManyCount--
        Object.assign(c, data)
        return { count: 1 }
      },
      update: async ({ where, data }: any) => {
        const c = state.costs[where.id]
        if (!c) throw new Error('no cost')
        Object.assign(c, data)
        return c
      },
      create: async ({ data, include }: any) => {
        const id = `n${state.created.length}`.padEnd(25, '0')
        const row = { id, ...data, lab: null }
        state.costs[id] = row
        state.created.push(data)
        return include ? { ...row, lab: null } : row
      },
    },
    labDocumentLine: {
      findMany: async ({ where }: any) =>
        state.lines.filter(
          (l) =>
            (where.costCaseId !== undefined ? l.costCaseId === where.costCaseId : true) &&
            (where.documentId ? l.documentId === where.documentId : true) &&
            (where.status ? l.status === where.status : true),
        ).map((l) => ({ ...l })),
      updateMany: async ({ where, data }: any) => {
        let n = 0
        for (const l of state.lines) {
          const hit =
            (where.costCaseId !== undefined ? l.costCaseId === where.costCaseId : true) &&
            (where.status ? l.status === where.status : true)
          if (hit) {
            Object.assign(l, data)
            n++
          }
        }
        return { count: n }
      },
      count: async ({ where }: any) =>
        state.lines.filter(
          (l) => (where.documentId ? l.documentId === where.documentId : true) && (where.status ? l.status === where.status : true),
        ).length,
    },
    labDocument: {
      findUnique: async ({ where }: any) => {
        const d = state.docs[where.id]
        return d ? { ...d, lines: state.lines.filter((l) => l.documentId === where.id) } : null
      },
      update: async ({ where, data }: any) => {
        const d = state.docs[where.id]
        if (!d) throw new Error('no doc')
        Object.assign(d, data)
        return d
      },
    },
    auditLog: { create: async (a: any) => state.audits.push(a.data) },
    // ★ merge cwm-payaudit-20261006（main 側）：PUT tx 內 SELECT…FOR UPDATE 再驗＋期間 advisory lock —
    //   fake 模擬（$executeRaw = no-op；$queryRaw 回目前 fake 行嘅 lockedByRunId）
    $executeRaw: async () => 0,
    $queryRaw: async (_t: unknown, ...values: any[]) => {
      const c = state.costs[values[0]]
      return c ? [{ lockedByRunId: c.lockedByRunId ?? null }] : []
    },
    $transaction: async (fn: any, _opts?: any) => {
      const snap = JSON.stringify({ costs: state.costs, docs: state.docs, lines: state.lines, audits: state.audits })
      try {
        return await fn(fakeForTx())
      } catch (e) {
        const back = JSON.parse(snap)
        state.costs = back.costs
        state.docs = back.docs
        state.lines = back.lines
        state.audits = back.audits
        throw e
      }
    },
  }

  function fakeForTx() {
    const f = makeFake(state) as any
    // tx 用同一份 fake（$transaction 自身已排除）
    delete f.$transaction
    return f
  }
}

const KEYS = ['user', 'clinic', 'provider', 'labMonthlyDiscount', 'payoutRun', 'costCase', 'labDocumentLine', 'labDocument', 'auditLog', '$transaction', '$queryRaw', '$executeRaw'] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]
after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

import { prisma } from '../prisma'

let PUT: any, DELETE: any, POST: any, RECOMPUTE: any
before(async () => {
  const idMod: any = await import('../../app/api/cost-cases/[id]/route')
  const listMod: any = await import('../../app/api/cost-cases/route')
  const reMod: any = await import('../../app/api/cost-cases/recompute/route')
  PUT = idMod.PUT
  DELETE = idMod.DELETE
  POST = listMod.POST
  RECOMPUTE = reMod.POST
})

function reset(state: State) {
  const fake = makeFake(state)
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
}

function mkState(over: Partial<State> = {}): State {
  return {
    costs: { [CC]: baseCost(CC) },
    docs: {
      [DOC]: { id: DOC, kind: 'INVOICE', status: 'RECONCILED', clinicId: CLINIC_1, docNo: 'INV-1', version: 3 },
    },
    lines: [
      { id: L1, documentId: DOC, groupIndex: 0, description: 'Crown', amount: 400, status: 'MATCHED', costCaseId: CC, linkType: 'MAIN', matchedBy: OWNER, matchedAt: new Date(), patientCode: 'TW007159', document: { docNo: 'INV-1' } },
      { id: L2, documentId: DOC, groupIndex: 0, description: 'Filling', amount: 100, status: 'MATCHED', costCaseId: CC_OTHER, linkType: 'MAIN', matchedBy: OWNER, matchedAt: new Date(), patientCode: 'TKW000042', document: { docNo: 'INV-1' } },
    ],
    audits: [],
    discount: { discountPct: 8.5, createdAt: new Date() },
    lockedRun: false,
    updateManyCount: 99,
    created: [],
    ...over,
  }
}

function putReq(body: unknown): NextRequest {
  return new NextRequest(`http://x/api/cost-cases/${CC}`, {
    method: 'PUT',
    headers: { cookie: `session=${tokenFor()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------- PUT §13（B4） ----------

test('PUT B4：labInvoiceLinked=true 冇傳 labId → 唔套折扣（finalCost=baseCost）＋discountPct 欄寫 null', async () => {
  const state = mkState()
  reset(state)
  const r = await PUT(putReq({ baseCost: 500 }) as any, { params: Promise.resolve({ id: CC }) } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.case.finalCost, 500)
  assert.strictEqual(body.case.discountPct, null)
  assert.strictEqual(state.costs[CC].discountPct, null)
  assert.strictEqual(state.costs[CC].finalCost, 500)
})

test('PUT B4：labInvoiceLinked=true 有傳 labId（表內有折扣）→ 一樣唔套折扣', async () => {
  const state = mkState()
  reset(state)
  const r = await PUT(putReq({ baseCost: 500, labId: LAB_1 }) as any, { params: Promise.resolve({ id: CC }) } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.case.finalCost, 500)
  assert.strictEqual(body.case.discountPct, null)
})

test('PUT 回歸：labInvoiceLinked=false → 月度折扣照常（8.5% → 457.5）', async () => {
  const state = mkState({ costs: { [CC]: baseCost(CC, { labInvoiceLinked: false, discountPct: null, finalCost: dec(500) }) } })
  reset(state)
  const r = await PUT(putReq({ baseCost: 500, labId: LAB_1 }) as any, { params: Promise.resolve({ id: CC }) } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.case.finalCost, 457.5)
  assert.strictEqual(body.case.discountPct, 8.5)
})

test('PUT §13：patientCode 改 → patientCodeNorm 重算（诊所 shortName 補前綴）', async () => {
  const state = mkState()
  reset(state)
  const r = await PUT(putReq({ patientCode: '7159' }) as any, { params: Promise.resolve({ id: CC }) } as any)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(state.costs[CC].patientCodeNorm, 'TW007159')
})

test('PUT §13：clinicId 改 → patientCodeNorm 用新診所 shortName 重算（TW → TKW）', async () => {
  const state = mkState()
  reset(state)
  const r = await PUT(putReq({ clinicId: CLINIC_2, patientCode: '7159' }) as any, { params: Promise.resolve({ id: CC }) } as any)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(state.costs[CC].clinicId, CLINIC_2)
  assert.strictEqual(state.costs[CC].patientCodeNorm, 'TKW007159')
})

test('PUT 並發鎖：updateMany(lockedByRunId null) 0 行 → 409＋零 audit', async () => {
  const state = mkState({ updateManyCount: 0 })
  reset(state)
  const r = await PUT(putReq({ baseCost: 500 }) as any, { params: Promise.resolve({ id: CC }) } as any)
  assert.strictEqual(r.status, 409)
  assert.strictEqual(state.audits.length, 0)
  assert.strictEqual(state.costs[CC].baseCost, 500)
})

// ---------- DELETE §7.9（T13） ----------

function delReq(): NextRequest {
  return new NextRequest(`http://x/api/cost-cases/${CC}`, {
    method: 'DELETE',
    headers: { cookie: `session=${tokenFor()}` },
  })
}

test('T13：作廢已連 invoice 嘅成本 → 行 UNMATCHED＋文件 RECONCILED→PARTIAL＋雙 audit', async () => {
  const state = mkState()
  reset(state)
  const r = await DELETE(delReq() as any, { params: Promise.resolve({ id: CC }) } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.deepStrictEqual(body.releasedLines, [L1])
  assert.deepStrictEqual(body.releasedDocs, [DOC])
  // 行：L1 解除；L2（其他成本）未動
  assert.strictEqual(state.lines.find((l) => l.id === L1)!.status, 'UNMATCHED')
  assert.strictEqual(state.lines.find((l) => l.id === L1)!.costCaseId, null)
  assert.strictEqual(state.lines.find((l) => l.id === L1)!.linkType, null)
  assert.strictEqual(state.lines.find((l) => l.id === L2)!.status, 'MATCHED')
  assert.strictEqual(state.lines.find((l) => l.id === L2)!.costCaseId, CC_OTHER)
  // 文件：RECONCILED → PARTIAL（仲有一條 MATCHED 行）
  assert.strictEqual(state.docs[DOC].status, 'PARTIAL')
  // 成本 VOID
  assert.strictEqual(state.costs[CC].status, 'VOID')
  // audit（單一來源 helper：action = spec §14 嘅 LAB_DOC_LINE_UNMATCH，notes「作廢成本」）
  const un = state.audits.find((a) => a.action === 'LAB_DOC_LINE_UNMATCH')
  assert.ok(un)
  assert.strictEqual(un.notes, '作廢成本')
  assert.match(un.beforeJson, /Crown/)
  const voidA = state.audits.find((a) => a.action === 'COST_CASE_VOID')
  assert.ok(voidA)
  assert.strictEqual(voidA.entityId, CC)
})

test('DELETE：無配對行 → 淨 void（無 LINE_UNMATCH audit、文件未動）', async () => {
  const state = mkState({ lines: [] })
  reset(state)
  const r = await DELETE(delReq() as any, { params: Promise.resolve({ id: CC }) } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.deepStrictEqual(body.releasedLines, [])
  assert.strictEqual(state.docs[DOC].status, 'RECONCILED', '文件未動')
  assert.strictEqual(state.audits.find((a) => a.action === 'LAB_DOC_LINE_UNMATCH'), undefined)
  assert.ok(state.audits.find((a) => a.action === 'COST_CASE_VOID'))
})

test('DELETE：已鎖（lockedByRunId）→ 409；已 VOID → 409；唔存在 → 404', async () => {
  const s1 = mkState({ costs: { [CC]: baseCost(CC, { lockedByRunId: 'r'.repeat(25) }) } })
  reset(s1)
  assert.strictEqual((await DELETE(delReq() as any, { params: Promise.resolve({ id: CC }) } as any)).status, 409)

  const s2 = mkState({ costs: { [CC]: baseCost(CC, { status: 'VOID' }) } })
  reset(s2)
  assert.strictEqual((await DELETE(delReq() as any, { params: Promise.resolve({ id: CC }) } as any)).status, 409)

  const s3 = mkState()
  reset(s3)
  assert.strictEqual((await DELETE(delReq() as any, { params: Promise.resolve({ id: 'z'.repeat(25) }) } as any)).status, 404)
})

// ---------- POST §13（F-26 + patientCodeNorm） ----------

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://x/api/cost-cases', {
    method: 'POST',
    headers: { cookie: `session=${tokenFor()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const POST_BODY = {
  providerId: PROV_1,
  clinicId: CLINIC_1,
  category: 'LAB',
  patientCode: '7159',
  orderedAt: '2026-09-01',
  receivedAt: '2026-09-15',
  baseCost: 100,
  labId: LAB_1,
}

test('POST F-26：目標月（醫生×診所×月）PayoutRun 已 LOCKED → 409＋零寫入', async () => {
  const state = mkState({ lockedRun: true })
  reset(state)
  const r = await POST(postReq(POST_BODY) as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r.status, 409)
  assert.strictEqual(state.created.length, 0)
  assert.strictEqual(state.audits.length, 0)
})

test('POST：未鎖月 → 201＋patientCodeNorm 寫入＋labInvoiceLinked=false 預設', async () => {
  const state = mkState()
  reset(state)
  const r = await POST(postReq(POST_BODY) as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r.status, 201)
  const body = await r.json()
  assert.strictEqual(body.case.patientCodeNorm, 'TW007159')
  assert.strictEqual(body.case.periodMonth, '2026-09')
  assert.strictEqual(state.created.length, 1)
  assert.ok(state.audits.find((a) => a.action === 'COST_CASE_CREATE'))
})

// ---------- recompute §13（B4） ----------

function recomputeReq(labId = LAB_1, month = '2026-09'): NextRequest {
  return new NextRequest('http://x/api/cost-cases/recompute', {
    method: 'POST',
    headers: { cookie: `session=${tokenFor()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ labId, periodMonth: month }),
  })
}

test('recompute B4：labInvoiceLinked=true 唔入重算；未連 invoice 嘅照常套折扣', async () => {
  const state = mkState({
    costs: {
      [CC]: baseCost(CC, { labInvoiceLinked: true, baseCost: 500, finalCost: dec(500), discountPct: 8.5 }),
      [CC_OTHER]: baseCost(CC_OTHER, { labInvoiceLinked: false, baseCost: 500, finalCost: dec(500), discountPct: null }),
    },
  })
  reset(state)
  const r = await RECOMPUTE(recomputeReq() as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.recomputedCount, 1)
  // 連咗 invoice 嘅 CC：完全未動
  assert.strictEqual(state.costs[CC].finalCost.v, 500)
  assert.strictEqual(state.costs[CC].discountPct, 8.5)
  // 未連嘅 CC_OTHER：套 8.5% 折扣（fake update 直接寫 number，冇 .v）
  assert.strictEqual(Number(state.costs[CC_OTHER].finalCost), 457.5)
  assert.strictEqual(state.costs[CC_OTHER].discountPct, 8.5)
})
