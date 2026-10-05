/**
 * cwm-labdoc P2 — §7.8 儲存分組 route unit
 *
 * 覆蓋：
 *  - 200：MATCH（MAIN）→ 行 MATCHED＋audit LINE_MATCH＋labInvoiceLinked=true＋文件 PARTIAL＋version+1
 *  - 200：IGNORE → 行 IGNORED＋audit；已 MATCHED 行先標忽略 → 409
 *  - 200：UNMATCH → 行 UNMATCHED＋audit；成本已出月結 → 409
 *  - B7（T6）：成本已有其他單嘅 MAIN → 400
 *  - T5：行已連咗其他成本（MATCHED 到不同 costCaseId）→ 409
 *  - §7.7：到貨確認 → receivedAt＋periodMonth（LAB 到貨月）；已出月結 → 409
 *  - §7.5：改價 FILL → baseCost = linkedSum（DB 重算，含今次 MATCH 行）、discountPct=null（B4）、PENDING→PRICED＋audit；
 *    已出月結 → 409
 *  - T4：冪等 replay（同 key 同 hash → 200 replayed；create 只 1 次）；同 key 唔同 hash → 409
 *  - version 唔等 → 409
 *  - 401 / 403 / 404 / 400 家族
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
const DOC_2 = 'b'.repeat(25)
const LINE_A = 'l'.repeat(25)
const LINE_B = 'm'.repeat(25)
const CC_1 = 'c'.repeat(25)
const CC_2 = 'd'.repeat(25)
const CLINIC_1 = 'k'.repeat(25)

process.env.JWT_SECRET = process.env.JWT_SECRET || 'p2-groupsave-test-secret-01234567'

function tokenFor(userId: string, role: string): string {
  return jwt.sign({ userId, role, clinics: [], tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })
}
function makeReq(url: string, tok: string | null, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: tok ? { cookie: `session=${tok}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

import { prisma } from '../prisma'
import { __setLabDocExtractFn } from './llm-client'

interface LineRow {
  id: string
  documentId: string
  groupIndex: number
  lineIndex: number
  description: string
  amount: number
  status: string
  costCaseId: string | null
  linkType: string | null
  ignoreReason: string | null
  matchedBy: string | null
  matchedAt: Date | null
  patientCode: string | null
}
interface CostRow {
  id: string
  clinicId: string
  status: string
  lockedByRunId: string | null
  baseCost: number | null
  finalCost: number | null
  discountPct: number | null
  labInvoiceLinked: boolean
  category: string
  orderedAt: Date
  receivedAt: Date | null
  periodMonth: string | null
  labId: string | null
  patientCodeNorm: string | null
}
interface State {
  doc: any
  lines: LineRow[]
  costs: CostRow[]
  docs2: Record<string, any>
  audits: any[]
  writeLog: Map<string, any>
  created: number
  serFailTimes: number
}

function mkLine(id: string, over: Partial<LineRow> = {}): LineRow {
  return {
    id,
    documentId: DOC_ID,
    groupIndex: 0,
    lineIndex: 0,
    description: 'Crown',
    amount: 300,
    status: 'UNMATCHED',
    costCaseId: null,
    linkType: null,
    ignoreReason: null,
    matchedBy: null,
    matchedAt: null,
    patientCode: null,
    ...over,
  }
}
function mkCost(id: string, over: Partial<CostRow> = {}): CostRow {
  return {
    id,
    clinicId: CLINIC_1,
    status: 'PENDING',
    lockedByRunId: null,
    baseCost: null,
    finalCost: null,
    discountPct: null,
    labInvoiceLinked: false,
    category: 'LAB',
    orderedAt: new Date('2026-09-01T00:00:00Z'),
    receivedAt: null,
    periodMonth: null,
    labId: null,
    patientCodeNorm: null,
    ...over,
  }
}
function mkDoc(over: Record<string, unknown> = {}): any {
  return {
    id: DOC_ID,
    kind: 'INVOICE',
    status: 'CONFIRMED',
    version: 1,
    labId: null,
    clinicId: CLINIC_1,
    providerId: null,
    docNo: 'INV-1',
    confirmedBy: OWNER,
    uploadedBy: OWNER,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  }
}

function makeFake(state: State) {
  // 行條件寫模擬（updateMany with status/costCaseId 條件）
  const statusMatch = (l: LineRow, st: any): boolean => {
    if (st === undefined || st === null) return true
    if (typeof st === 'string') return l.status === st
    if (st.in) return st.in.includes(l.status)
    return true
  }
  const lineUpdateMany = async (args: any) => {
    const w = args.where
    const hit = state.lines.find(
      (l) => l.id === w.id && statusMatch(l, w.status) &&
        (w.costCaseId !== undefined ? l.costCaseId === w.costCaseId : true) &&
        (w.OR ? w.OR.some((o: any) => statusMatch(l, o.status) && (o.costCaseId !== undefined ? l.costCaseId === o.costCaseId : true)) : true),
    )
    if (!hit) return { count: 0 }
    Object.assign(hit, args.data)
    return { count: 1 }
  }
  const docIdMatch = (l: LineRow, di: any): boolean => {
    if (di === undefined || di === null) return true
    if (typeof di === 'string') return l.documentId === di
    if (di.not !== undefined) return l.documentId !== di.not
    if (di.in) return di.in.includes(l.documentId)
    return true
  }

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
      findUnique: async ({ where }: any) =>
        where.id === state.doc.id ? { ...state.doc, lines: state.lines.map((l) => ({ ...l })) } : state.docs2[where.id] ?? null,
      updateMany: async ({ where, data }: any) => {
        // version 樂觀鎖模擬
        if (where.id === state.doc.id && where.version === state.doc.version) {
          if (data.version?.increment) state.doc.version += data.version.increment
          if (data.status) state.doc.status = data.status
          return { count: 1 }
        }
        if (where.id && where.status?.in && state.docs2[where.id] && where.status.in.includes(state.docs2[where.id].status)) {
          Object.assign(state.docs2[where.id], data)
          return { count: 1 }
        }
        return { count: 0 }
      },
      update: async ({ id, data }: any) => {
        Object.assign(state.doc, data)
        return { ...state.doc, lines: state.lines }
      },
      findMany: async ({ where }: any) => Object.values(state.docs2).filter((d: any) => (where.id?.in ? where.id.in.includes(d.id) : true)),
    },
    labDocumentLine: {
      findMany: async ({ where }: any) =>
        state.lines
          .filter(
            (l) =>
              docIdMatch(l, where.documentId) &&
              (where.costCaseId ? l.costCaseId === where.costCaseId : true) &&
              (where.costCaseId?.in ? where.costCaseId.in.includes(l.costCaseId) : true) &&
              statusMatch(l, where.status) &&
              (where.linkType ? l.linkType === where.linkType : true),
          )
          .map((l) => ({ ...l })), // copy — 防 caller 改到 state（真 Prisma 回 copy）
      updateMany: lineUpdateMany,
      count: async ({ where }: any) =>
        state.lines.filter(
          (l) => docIdMatch(l, where.documentId) && statusMatch(l, where.status),
        ).length,
    },
    costCase: {
      findUnique: async ({ where }: any) => {
        const hit = state.costs.find((c) => c.id === where.id)
        return hit ? { ...hit } : null
      },
      findMany: async ({ where }: any) =>
        state.costs.filter(
          (c) =>
            (where.id?.in ? where.id.in.includes(c.id) : true) &&
            (where.status?.not ? c.status !== where.status.not : true) &&
            (where.lockedByRunId !== undefined ? (where.lockedByRunId === null ? c.lockedByRunId === null : c.lockedByRunId === where.lockedByRunId) : true) &&
            (where.periodMonth ? c.periodMonth === where.periodMonth : true) &&
            (where.lockedByRunId?.not ? c.lockedByRunId === where.lockedByRunId.not : true),
        ),
      updateMany: async ({ where, data }: any) => {
        const hit = state.costs.find(
          (c) =>
            c.id === where.id &&
            (where.lockedByRunId !== undefined ? (where.lockedByRunId === null ? c.lockedByRunId === null : c.lockedByRunId === where.lockedByRunId) : true),
        )
        if (!hit) return { count: 0 }
        Object.assign(hit, data)
        return { count: 1 }
      },
      update: async ({ where, data }: any) => {
        const hit = state.costs.find((c) => c.id === where.id)
        if (!hit) throw new Error('no cost')
        Object.assign(hit, data)
        return hit
      },
      findFirst: async ({ where }: any) =>
        state.costs.find(
          (c) =>
            (where.periodMonth ? c.periodMonth === where.periodMonth : true) &&
            (where.lockedByRunId?.not ? c.lockedByRunId === where.lockedByRunId.not : true) &&
            (where.labId ? c.id !== undefined : true),
        ) ?? null,
    },
    clinic: { findUnique: async () => ({ id: CLINIC_1, name: '大圍', shortName: 'TW' }) },
    auditLog: { create: async (a: any) => state.audits.push(a.data) },
    labDocWriteLog: {
      findUnique: async ({ where }: any) => state.writeLog.get(where.idempotencyKey) ?? null,
      create: async ({ data }: any) => {
        const row = { ...data, responseJson: null }
        state.writeLog.set(data.idempotencyKey, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const row = state.writeLog.get(where.idempotencyKey)
        if (!row) throw new Error('no write log')
        Object.assign(row, data)
        return row
      },
    },
    $transaction: async (fn: any, _opts?: any) => {
      // §7.8 serialization 重試模擬 + 真 DB rollback 語義（fail/throw → 還原快照）
      if (state.serFailTimes > 0) {
        state.serFailTimes--
        const e: any = new Error('could not serialize access due to concurrent update')
        e.name = 'PrismaClientKnownRequestError'
        e.code = 'P2010'
        e.meta = { code: '40001', message: 'could not serialize access due to concurrent update' }
        throw e
      }
      const snap = structuredClone(state)
      try {
        const r = await fn(makeFake(state))
        if (r && typeof r === 'object' && 'fail' in r) Object.assign(state, snap)
        return r
      } catch (e) {
        Object.assign(state, snap)
        throw e
      }
    },
  }
}

const KEYS = ['user', 'labDocument', 'labDocumentLine', 'costCase', 'clinic', 'auditLog', 'labDocWriteLog', '$transaction'] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]
after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

let POST: any
before(async () => {
  __setLabDocExtractFn(async () => ({ outcome: null, nullReason: null }))
  const mod = await import('../../app/api/lab-docs/[id]/groups/[g]/save/route')
  POST = mod.POST
})

function reset(state: State) {
  const fake = makeFake(state)
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
}

function baseState(over: Partial<State> = {}): State {
  return {
    doc: mkDoc(),
    lines: [
      mkLine(LINE_A, { amount: 300 }),
      mkLine(LINE_B, { amount: 200, lineIndex: 1, description: 'Filling' }),
    ],
    costs: [mkCost(CC_1), mkCost(CC_2, { baseCost: 500, status: 'PRICED', finalCost: 500 })],
    docs2: {},
    audits: [],
    writeLog: new Map(),
    created: 0,
    serFailTimes: 0,
    ...over,
  }
}

const URL_0 = 'http://x/api/lab-docs/' + DOC_ID + '/groups/0/save'
const KEY_1 = 'save-001'

test('§7.8 200：MATCH MAIN → MATCHED＋audit＋labInvoiceLinked＋PARTIAL＋version+1', async () => {
  const state = baseState()
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.status, 'PARTIAL')
  assert.strictEqual(body.version, 2)
  const la = state.lines.find((l) => l.id === LINE_A)!
  assert.strictEqual(la.status, 'MATCHED')
  assert.strictEqual(la.costCaseId, CC_1)
  assert.strictEqual(la.linkType, 'MAIN')
  assert.strictEqual(state.costs.find((c) => c.id === CC_1)!.labInvoiceLinked, true)
  assert.ok(state.audits.some((a) => a.action === 'LAB_DOC_LINE_MATCH'), 'LINE_MATCH audit')
  assert.ok(state.audits.some((a) => a.action === 'LAB_DOC_UPDATE'), 'DOC_UPDATE audit')
})

test('§7.8 B7（T6）：成本已有其他單 MAIN → 400', async () => {
  const state = baseState()
  // DOC_2 有一行已 MATCHED MAIN 到 CC_1
  state.docs2[DOC_2] = mkDoc({ id: DOC_2, docNo: 'INV-2' })
  state.lines.push(mkLine('n'.repeat(25), { documentId: DOC_2, status: 'MATCHED', costCaseId: CC_1, linkType: 'MAIN' }))
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 400)
  const out = await r.json()
  assert.match(out.error, /主單/)
})

test('§7.8 T5：行已連咗其他成本 → 409（LINE_TAKEN）', async () => {
  const state = baseState()
  state.lines[0] = mkLine(LINE_A, { status: 'MATCHED', costCaseId: CC_2, linkType: 'MAIN' })
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 409)
})

test('§7.8 IGNORE：200＋audit；已 MATCHED 行標忽略 → 409；缺 reason → 400', async () => {
  {
    const state = baseState()
    reset(state)
    const r = await POST(
      makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
        idempotencyKey: KEY_1,
        version: 1,
        lines: [{ lineId: LINE_B, action: 'IGNORE', ignoreReason: '唔係我哋嘅' }],
      }) as any,
      { params: { id: DOC_ID, g: '0' } } as any,
    )
    assert.strictEqual(r.status, 200)
    assert.strictEqual(state.lines.find((l) => l.id === LINE_B)!.status, 'IGNORED')
    assert.ok(state.audits.some((a) => a.action === 'LAB_DOC_LINE_IGNORE'))
  }
  {
    const state = baseState()
    state.lines[1] = mkLine(LINE_B, { status: 'MATCHED', costCaseId: CC_1, linkType: 'MAIN' })
    reset(state)
    const r = await POST(
      makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
        idempotencyKey: KEY_1,
        version: 1,
        lines: [{ lineId: LINE_B, action: 'IGNORE', ignoreReason: '唔係我哋嘅' }],
      }) as any,
      { params: { id: DOC_ID, g: '0' } } as any,
    )
    assert.strictEqual(r.status, 409)
  }
  {
    const state = baseState()
    reset(state)
    const r = await POST(
      makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
        idempotencyKey: KEY_1,
        version: 1,
        lines: [{ lineId: LINE_B, action: 'IGNORE' }],
      }) as any,
      { params: { id: DOC_ID, g: '0' } } as any,
    )
    assert.strictEqual(r.status, 400)
  }
})

test('§7.8 UNMATCH：200＋audit；成本已出月結 → 409', async () => {
  {
    const state = baseState()
    state.lines[0] = mkLine(LINE_A, { status: 'MATCHED', costCaseId: CC_1, linkType: 'MAIN' })
    reset(state)
    const r = await POST(
      makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
        idempotencyKey: KEY_1,
        version: 1,
        lines: [{ lineId: LINE_A, action: 'UNMATCH', costCaseId: CC_1 }],
      }) as any,
      { params: { id: DOC_ID, g: '0' } } as any,
    )
    assert.strictEqual(r.status, 200)
    const la = state.lines.find((l) => l.id === LINE_A)!
    assert.strictEqual(la.status, 'UNMATCHED')
    assert.strictEqual(la.costCaseId, null)
    assert.ok(state.audits.some((a) => a.action === 'LAB_DOC_LINE_UNMATCH'))
  }
  {
    const state = baseState()
    state.lines[0] = mkLine(LINE_A, { status: 'MATCHED', costCaseId: CC_1, linkType: 'MAIN' })
    state.costs[0] = mkCost(CC_1, { lockedByRunId: 'run'.padEnd(25, '0') })
    reset(state)
    const r = await POST(
      makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
        idempotencyKey: KEY_1,
        version: 1,
        lines: [{ lineId: LINE_A, action: 'UNMATCH', costCaseId: CC_1 }],
      }) as any,
      { params: { id: DOC_ID, g: '0' } } as any,
    )
    assert.strictEqual(r.status, 409)
  }
})

test('§7.7 到貨確認：receivedAt＋periodMonth（到貨月）；已出月結 → 409', async () => {
  {
    const state = baseState()
    state.lines[0] = mkLine(LINE_A, { status: 'MATCHED', costCaseId: CC_1, linkType: 'MAIN' })
    reset(state)
    const r = await POST(
      makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
        idempotencyKey: KEY_1,
        version: 1,
        lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN', receivedAt: '2026-09-15' }],
      }) as any,
      { params: { id: DOC_ID, g: '0' } } as any,
    )
    assert.strictEqual(r.status, 200)
    const cc = state.costs.find((c) => c.id === CC_1)!
    assert.strictEqual(cc.receivedAt?.toISOString().slice(0, 10), '2026-09-15')
    assert.strictEqual(cc.periodMonth, '2026-09')
  }
  {
    const state = baseState()
    state.lines[0] = mkLine(LINE_A, { status: 'MATCHED', costCaseId: CC_1, linkType: 'MAIN' })
    state.costs[0] = mkCost(CC_1, { lockedByRunId: 'run'.padEnd(25, '0'), receivedAt: new Date('2026-09-01T00:00:00Z') })
    reset(state)
    const r = await POST(
      makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
        idempotencyKey: KEY_1,
        version: 1,
        lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN', receivedAt: '2026-10-01' }],
      }) as any,
      { params: { id: DOC_ID, g: '0' } } as any,
    )
    assert.strictEqual(r.status, 409)
  }
})

test('§7.5 改價：baseCost = linkedSum（含今次 MATCH 行）＋discountPct=null＋PRICED＋audit', async () => {
  const state = baseState()
  state.costs[0] = mkCost(CC_1, { baseCost: null, status: 'PENDING' })
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
      priceUpdates: [{ costCaseId: CC_1 }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 200)
  const cc = state.costs.find((c) => c.id === CC_1)!
  assert.strictEqual(cc.baseCost, 300) // linkedSum = LINE_A 300
  assert.strictEqual(cc.finalCost, 300)
  assert.strictEqual(cc.discountPct, null)
  assert.strictEqual(cc.status, 'PRICED')
  const audit = state.audits.find((a) => a.action === 'LAB_DOC_PRICE_UPDATE')
  assert.ok(audit)
  const before = JSON.parse(audit.beforeJson)
  assert.strictEqual(before.baseCost, null)
})

test('§7.5 改價：已出月結 → 409', async () => {
  const state = baseState()
  state.lines[0] = mkLine(LINE_A, { status: 'MATCHED', costCaseId: CC_1, linkType: 'MAIN' })
  state.costs[0] = mkCost(CC_1, { baseCost: 300, lockedByRunId: 'run'.padEnd(25, '0') })
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
      priceUpdates: [{ costCaseId: CC_1 }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 409)
})

test('T4 冪等：replay 200（只 1 次配對）；同 key 唔同 hash → 409', async () => {
  const state = baseState()
  reset(state)
  const url = URL_0
  const body1 = { idempotencyKey: KEY_1, version: 1, lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }] }
  const r1 = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), body1) as any, { params: { id: DOC_ID, g: '0' } } as any)
  assert.strictEqual(r1.status, 200)
  const r2 = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), body1) as any, { params: { id: DOC_ID, g: '0' } } as any)
  assert.strictEqual(r2.status, 200)
  const b2 = await r2.json()
  assert.strictEqual(b2.replayed, true)
  // replay 唔會二次寫（行仍然 1 次 MATCHED）
  assert.strictEqual(state.lines.find((l) => l.id === LINE_A)!.status, 'MATCHED')

  const r3 = await POST(
    makeReq(url, tokenFor(OWNER, 'OWNER'), { idempotencyKey: KEY_1, version: 1, lines: [{ lineId: LINE_B, action: 'MATCH', costCaseId: CC_2, linkType: 'MAIN' }] }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r3.status, 409)
})

test('§7.8 version 唔等 → 409', async () => {
  const state = baseState()
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 99,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 409)
})

test('auth／格式：401 / 403 / 404 / 400', async () => {
  const state = baseState()
  reset(state)
  const body = { idempotencyKey: KEY_1, version: 1, lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }] }

  assert.strictEqual((await POST(makeReq(URL_0, null, body) as any, { params: { id: DOC_ID, g: '0' } } as any)).status, 401)

  const e = await POST(makeReq(URL_0, tokenFor(EMPLOYEE, 'EMPLOYEE'), body) as any, { params: { id: DOC_ID, g: '0' } } as any)
  assert.strictEqual(e.status, 403)

  // 404：doc id 唔同
  const state2 = baseState({ doc: mkDoc({ id: 'z'.repeat(25) }) })
  reset(state2)
  assert.strictEqual((await POST(makeReq(URL_0, tokenFor(OWNER, 'OWNER'), body) as any, { params: { id: DOC_ID, g: '0' } } as any)).status, 404)

  reset(state)
  // 400：壞 doc id / 壞 group / 壞 version / 冇 lines / lineId 唔屬分組
  assert.strictEqual((await POST(makeReq('http://x/api/lab-docs/bad/groups/0/save', tokenFor(OWNER, 'OWNER'), body) as any, { params: { id: 'bad', g: '0' } } as any)).status, 400)
  assert.strictEqual((await POST(makeReq(URL_0, tokenFor(OWNER, 'OWNER'), body) as any, { params: { id: DOC_ID, g: '99' } } as any)).status, 400)
  assert.strictEqual((await POST(makeReq(URL_0, tokenFor(OWNER, 'OWNER'), { ...body, version: 'x' }) as any, { params: { id: DOC_ID, g: '0' } } as any)).status, 400)
  assert.strictEqual((await POST(makeReq(URL_0, tokenFor(OWNER, 'OWNER'), { ...body, lines: [] }) as any, { params: { id: DOC_ID, g: '0' } } as any)).status, 400)
  assert.strictEqual((await POST(makeReq(URL_0, tokenFor(OWNER, 'OWNER'), { ...body, lines: [{ lineId: 'x'.repeat(25), action: 'IGNORE', ignoreReason: 'no' }] }) as any, { params: { id: DOC_ID, g: '0' } } as any)).status, 400)
})

// ============================================================
// gen4（2026-10-05）：T12 IDOR／SAVING gate／T7 rollback／serialization retry
// ============================================================

test('§3.4：NEEDS_REVIEW（頭部未確認）→ 400 唔可以對數', async () => {
  const state = baseState({ doc: mkDoc({ status: 'NEEDS_REVIEW' }) })
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 400)
  assert.match((await r.json()).error, /確認/)
})

test('§7.8 T12：成本唔係呢張單 Lab → 400＋零寫入', async () => {
  const state = baseState({ doc: mkDoc({ labId: 'L1'.padEnd(25, '0') }) })
  state.costs[0] = mkCost(CC_1, { labId: 'L2'.padEnd(25, '0') })
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 400)
  assert.match((await r.json()).error, /Lab/)
  // rollback：行冇變
  assert.strictEqual(state.lines.find((l) => l.id === LINE_A)!.status, 'UNMATCHED')
  assert.strictEqual(state.audits.length, 0)
})

test('§7.8 T12：病人編號唔匹配（行 patientCode vs 成本 patientCodeNorm）→ 400', async () => {
  const state = baseState()
  state.lines[0] = mkLine(LINE_A, { patientCode: 'TW007159' })
  state.costs[0] = mkCost(CC_1, { patientCodeNorm: 'TKW002004' })
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 400)
  assert.match((await r.json()).error, /病人編號/)
})

test('§7.8 T12：病人匹配（patientCode === patientCodeNorm）→ 200', async () => {
  const state = baseState()
  state.lines[0] = mkLine(LINE_A, { patientCode: 'TW007159' })
  state.costs[0] = mkCost(CC_1, { patientCodeNorm: 'TW007159' })
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 200)
})

test('§7.8 T12：改價跨 Lab → 400', async () => {
  const state = baseState({ doc: mkDoc({ labId: 'L1'.padEnd(25, '0') }) })
  state.costs[0] = mkCost(CC_1, { labId: 'L2'.padEnd(25, '0'), baseCost: 500, status: 'PRICED', finalCost: 500 })
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_B, action: 'IGNORE', ignoreReason: 'no' }],
      priceUpdates: [{ costCaseId: CC_1 }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 400)
  assert.match((await r.json()).error, /Lab/)
})

test('T7：save 中途成本被鎖 → 409＋全部 rollback（行冇變、冇 audit）', async () => {
  const state = baseState()
  state.costs[1] = mkCost(CC_2, { baseCost: 500, status: 'PRICED', finalCost: 500, lockedByRunId: 'run'.padEnd(25, '0') })
  reset(state)
  const r = await POST(
    makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
      idempotencyKey: KEY_1,
      version: 1,
      lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
      priceUpdates: [{ costCaseId: CC_2 }],
    }) as any,
    { params: { id: DOC_ID, g: '0' } } as any,
  )
  assert.strictEqual(r.status, 409)
  assert.match((await r.json()).error, /月結/)
  // T7：MATCH 嗰行都回滾
  const la = state.lines.find((l) => l.id === LINE_A)!
  assert.strictEqual(la.status, 'UNMATCHED')
  assert.strictEqual(la.costCaseId, null)
  assert.strictEqual(state.audits.length, 0)
  assert.strictEqual(state.doc.version, 1)
})

test('§7.8 serialization error：1 次重試後成功；3 次 fail → 500', async () => {
  {
    const state = baseState({ serFailTimes: 1 })
    reset(state)
    const r = await POST(
      makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
        idempotencyKey: KEY_1,
        version: 1,
        lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
      }) as any,
      { params: { id: DOC_ID, g: '0' } } as any,
    )
    assert.strictEqual(r.status, 200)
    assert.strictEqual(state.lines.find((l) => l.id === LINE_A)!.status, 'MATCHED')
  }
  {
    const state = baseState({ serFailTimes: 3 })
    reset(state)
    const r = await POST(
      makeReq(URL_0, tokenFor(OWNER, 'OWNER'), {
        idempotencyKey: KEY_1,
        version: 1,
        lines: [{ lineId: LINE_A, action: 'MATCH', costCaseId: CC_1, linkType: 'MAIN' }],
      }) as any,
      { params: { id: DOC_ID, g: '0' } } as any,
    )
    assert.strictEqual(r.status, 500)
    assert.strictEqual(state.lines.find((l) => l.id === LINE_A)!.status, 'UNMATCHED')
  }
})
