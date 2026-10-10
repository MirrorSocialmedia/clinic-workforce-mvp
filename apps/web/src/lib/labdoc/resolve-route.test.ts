/**
 * cwm-labdoc P3 — §8.3 resolve route unit（fake prisma，跟 labdoc-void.test.ts 做法）
 *
 * 覆蓋：
 *  - INVOICE_WINS：200、行入跟進（result 唔變、followUpClosedAt=null）、audit
 *  - STATEMENT_WINS：要原因；未配對 400；invoice 級改 doc.total；行級改行+total 差額；
 *    成本鏈：未鎖要確認（needsCostConfirm 零寫入）→ 確認後 applyPriceUpdate；已鎖照改系統＋標記下期
 *  - MANUAL_PAIRED：範圍外 400；範圍內比 total／行
 *  - NOT_OURS：要原因
 *  - 權限／IDOR／重複處理
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { NextRequest } from 'next/server'
import { createRequire } from 'node:module'

const req2 = createRequire(import.meta.url)
const jwt: any = req2('jsonwebtoken')

const OWNER = 'f'.repeat(25)
const INV_ONLY = 'i'.repeat(25) // EMPLOYEE + grant lab_invoice（無 lab_statement → T11 403）
const DOC_ID = 'a'.repeat(25)
const SEC_ID = 'b'.repeat(25)
const LINE_ID = 'c'.repeat(25)
const SYS_DOC_ID = 'd'.repeat(25)
const SYS_LINE_ID = 'e'.repeat(25)
const CC_ID = 'g'.repeat(25)
const CLINIC = 'k'.repeat(25)
const PROVIDER = 'p'.repeat(25)
const LAB = 'l'.repeat(25)

process.env.JWT_SECRET = process.env.JWT_SECRET || 'p3-resolve-test-secret-0123456789'

function tokenFor(userId: string, role: string, grant: string[] = []): string {
  return jwt.sign({ userId, role, clinics: [], tokenVersion: 0, permissionsJson: { grant } }, process.env.JWT_SECRET, { expiresIn: '1h' })
}
function makeReq(tok: string, body: unknown, path: string): NextRequest {
  return new NextRequest(`http://x${path}`, {
    method: 'POST',
    headers: { cookie: `session=${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ------------------------------------------------------------------
// fake state
// ------------------------------------------------------------------

interface St {
  doc: any
  sysDoc: any
  section: any
  line: any
  cc: any
  matchedCostLines: Array<{ amount: number }>
  profile: any
  audits: any[]
  sysLineWrites: any[]
  sysDocUpdates: any[]
  ccWrites: any[]
}

function mkState(over: Partial<St> = {}): St {
  const base: St = {
    doc: {
      id: DOC_ID, kind: 'STATEMENT', status: 'IN_PROGRESS', labId: LAB,
      statementMonth: '2026-09', clinicId: CLINIC, providerId: PROVIDER, version: 3,
    },
    sysDoc: {
      id: SYS_DOC_ID, kind: 'INVOICE', status: 'CONFIRMED', labId: LAB,
      clinicId: CLINIC, providerId: PROVIDER, docNo: 'INV-1',
      docDate: new Date('2026-09-15T00:00:00Z'), total: 300,
      lines: [{ id: SYS_LINE_ID, description: '全鋯', toothRaw: '16', qty: 1, unitPrice: 100, amount: 300, patientCode: 'X1', costCaseId: CC_ID, status: 'MATCHED' }],
    },
    section: { id: SEC_ID, clinicId: CLINIC, providerId: PROVIDER, statedTotal: 250, statedCurrent: null, resultJson: null },
    line: {
      id: LINE_ID, sectionId: SEC_ID, lineIndex: 0, lineType: 'INVOICE',
      docNo: 'INV-1', date: new Date('2026-09-15T00:00:00Z'), patientCode: null,
      description: '全鋯', toothRaw: '16', qty: 1, unitPrice: 100, amount: 250,
      agingBucket: null, matchedDocumentId: SYS_DOC_ID, matchedLineId: SYS_LINE_ID,
      matchBasis: 'DOC_NO', result: 'AMOUNT_DIFF',
      resolution: null, resolutionNote: null, resolvedBy: null, resolvedAt: null,
      followUpClosedAt: null, followUpClosedBy: null,
    },
    cc: { id: CC_ID, itemType: 'CROWN', baseCost: 300, finalCost: 300, discountPct: null, lockedByRunId: null, status: 'PRICED', clinicId: CLINIC, providerId: PROVIDER },
    matchedCostLines: [{ amount: 300 }], // 該成本已 MATCHED 行（computeLinkedSumDb 底）
    profile: { labId: LAB, statementKind: 'INVOICE_LIST', statementDocNoSameAsInvoice: true },
    audits: [],
    sysLineWrites: [],
    sysDocUpdates: [],
    ccWrites: [],
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
    labProfile: { findUnique: async () => state.profile },
    labDocument: {
      findUnique: async ({ where }: any) =>
        where.id === state.doc.id ? { ...state.doc }
          : where.id === state.sysDoc.id ? { ...state.sysDoc, lines: state.sysDoc.lines }
            : null,
      findMany: async ({ where }: any) => {
        // 範圍查詢（kind=INVOICE + status + lab/clinic/provider + docDate 窗）
        if (where.kind !== 'INVOICE') return []
        const cand = { ...state.sysDoc }
        if (!where.status?.in?.includes(cand.status)) return []
        if (where.labId && cand.labId !== where.labId) return []
        if (where.clinicId && cand.clinicId !== where.clinicId) return []
        if (where.providerId && cand.providerId !== where.providerId) return []
        if (where.docDate) {
          if (!cand.docDate || cand.docDate < where.docDate.gte || cand.docDate > where.docDate.lte) return []
        }
        return [{ ...cand }]
      },
      update: async ({ where, data }: any) => {
        if (where.id === state.sysDoc.id) {
          state.sysDocUpdates.push(data)
          Object.assign(state.sysDoc, data)
        } else {
          Object.assign(state.doc, data)
        }
        return { ok: true }
      },
    },
    labDocumentLine: {
      findMany: async ({ where }: any) => {
        if (where.costCaseId) return state.matchedCostLines.map((m) => ({ id: 'ml', amount: m.amount }))
        return []
      },
      update: async ({ where, data }: any) => {
        if (where.id === SYS_LINE_ID) {
          state.sysLineWrites.push(data)
          const l = state.sysDoc.lines.find((x: any) => x.id === SYS_LINE_ID)
          Object.assign(l, data)
        }
        return { ok: true }
      },
    },
    costCase: {
      findUnique: async ({ where }: any) => (where.id === CC_ID ? { ...state.cc } : null),
      updateMany: async ({ where, data }: any) => {
        if (where.id === CC_ID && where.lockedByRunId === null && state.cc.lockedByRunId == null) {
          state.ccWrites.push(data)
          Object.assign(state.cc, data)
          return { count: 1 }
        }
        return { count: 0 }
      },
    },
    labStatementSection: {
      findFirst: async ({ where }: any) => (where?.document ? null : { ...state.section }), // where.document = §8.1 重複查詢
      updateMany: async ({ where, data }: any) => {
        if (where.id === state.section.id && where.documentId === state.doc.id) {
          Object.assign(state.section, data)
          return { count: 1 }
        }
        return { count: 0 }
      },
    },
    labStatementLine: {
      findFirst: async ({ where }: any) =>
        where.id === state.line.id && where.sectionId === state.line.sectionId ? { ...state.line } : null,
      findMany: async () => [
        { result: state.line.result, matchedDocumentId: state.line.matchedDocumentId, matchedLineId: state.line.matchedLineId, resolution: state.line.resolution },
      ],
      update: async ({ where, data }: any) => {
        if (where.id === LINE_ID) Object.assign(state.line, data)
        return { ok: true }
      },
      updateMany: async ({ where, data }: any) => {
        if (where.id === LINE_ID && (where.resolution === undefined || where.resolution === state.line.resolution) && (where.followUpClosedAt === undefined || where.followUpClosedAt === state.line.followUpClosedAt)) {
          Object.assign(state.line, data)
          return { count: 1 }
        }
        return { count: 0 }
      },
    },
    auditLog: { create: async (a: any) => state.audits.push(a.data) },
    $transaction: async (fn: any) => fn(makeFake(state)),
  }
}

const KEYS = ['user', 'labProfile', 'labDocument', 'labDocumentLine', 'costCase', 'labStatementSection', 'labStatementLine', 'auditLog', '$transaction'] as const
import { prisma } from '../prisma'
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]

let POST: any
let CLOSE: any
before(async () => {
  const mod = await import('../../app/api/lab-docs/[id]/sections/[sid]/lines/[lid]/resolve/route')
  POST = mod.POST
  const cmod = await import('../../app/api/lab-docs/[id]/sections/[sid]/lines/[lid]/close-followup/route')
  CLOSE = cmod.POST
})

function reset(state: St) {
  const fake = makeFake(state)
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
}
after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

const PATH = `/api/lab-docs/${DOC_ID}/sections/${SEC_ID}/lines/${LINE_ID}/resolve`

// ------------------------------------------------------------------
// INVOICE_WINS
// ------------------------------------------------------------------

test('INVOICE_WINS：200、result 唔變、入跟進（followUpClosedAt=null）、audit', async () => {
  const st = mkState()
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'INVOICE_WINS' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(st.line.resolution, 'INVOICE_WINS')
  assert.strictEqual(st.line.result, 'AMOUNT_DIFF', '唔改系統、result 保留')
  assert.strictEqual(st.line.followUpClosedAt, null)
  assert.strictEqual(st.sysLineWrites.length, 0, '唔改系統行')
  assert.ok(st.audits.find((a) => a.action === 'LAB_STATEMENT_RESOLVE'))
})

test('改處理：分段未確認 INVOICE_WINS → NOT_OURS 准改；已確認／STATEMENT_WINS → 409', async () => {
  let st = mkState({ line: { ...mkState().line, resolution: 'INVOICE_WINS', resolvedAt: new Date() } })
  reset(st)
  let r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'NOT_OURS', note: '唔係我哋' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  st = mkState({ line: { ...mkState().line, resolution: 'INVOICE_WINS', resolvedAt: new Date() }, section: { ...mkState().section, status: 'CONFIRMED' } })
  reset(st)
  r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'NOT_OURS', note: 'x' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 409)
  st = mkState({ line: { ...mkState().line, resolution: 'STATEMENT_WINS', resolvedAt: new Date() } })
  reset(st)
  r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'INVOICE_WINS' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 409)
})

// ------------------------------------------------------------------
// STATEMENT_WINS
// ------------------------------------------------------------------

test('STATEMENT_WINS：無原因 → 400', async () => {
  const st = mkState()
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'STATEMENT_WINS' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 400)
})

test('STATEMENT_WINS：未配對行 → 400', async () => {
  const st = mkState({ line: { ...mkState().line, matchedDocumentId: null, matchedLineId: null, result: 'MISSING_IN_SYSTEM' } })
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'STATEMENT_WINS', note: '月結單啱' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 400)
})

test('STATEMENT_WINS 行級（無成本）：改系統行 amount＋doc total 差額、行 MATCHED、LAB_STATEMENT_ADJUST', async () => {
  const st = mkState()
  st.sysDoc.lines[0].costCaseId = null
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'STATEMENT_WINS', note: '月結單啱' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.line.result, 'MATCHED')
  // 系統行 amount 300 → 250；doc total 300 → 250
  assert.strictEqual(st.sysLineWrites.length, 1)
  assert.strictEqual(st.sysLineWrites[0].amount, 250)
  assert.strictEqual(st.sysDocUpdates[0].total, 250)
  assert.strictEqual(st.line.result, 'MATCHED')
  assert.strictEqual(st.line.resolution, 'STATEMENT_WINS')
  const adj = st.audits.find((a) => a.action === 'LAB_STATEMENT_ADJUST')
  assert.ok(adj, 'LAB_STATEMENT_ADJUST audit')
  const before = JSON.parse(adj.beforeJson)
  const after = JSON.parse(adj.afterJson)
  assert.strictEqual(before.line.amount, 300)
  assert.strictEqual(after.line.amount, 250)
  // section 重算：systemTotal = 250 = statedTotal → OK
  assert.strictEqual(st.section.status, 'OK')
  assert.strictEqual(st.section.systemTotal, 250)
  assert.strictEqual(st.line.resolution, 'STATEMENT_WINS')
})

test('STATEMENT_WINS 整張單配對（單號型，冇 matchedLineId）：單行 invoice → 改嗰行＋total，唔係淨改 total', async () => {
  const st = mkState()
  st.sysDoc.lines[0].costCaseId = null
  st.line = { ...st.line, matchedLineId: null, qty: null, unitPrice: null, description: null }
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'STATEMENT_WINS', note: '月結單啱' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(st.sysLineWrites.length, 1, '系統行有改')
  assert.strictEqual(st.sysLineWrites[0].amount, 250)
  assert.strictEqual(st.sysDocUpdates[0].total, 250)
})

test('STATEMENT_WINS 整張單配對＋多行 invoice 冇 systemLineId → 400 要揀行', async () => {
  const st = mkState()
  st.sysDoc.lines.push({ ...st.sysDoc.lines[0], id: 'z'.repeat(25), amount: 50, costCaseId: null })
  st.line = { ...st.line, matchedLineId: null, qty: null, unitPrice: null }
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'STATEMENT_WINS', note: 'x' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 400)
  assert.strictEqual((await r.json()).code, 'PICK_SYSTEM_LINE')
  assert.strictEqual(st.sysLineWrites.length, 0)
})

test('STATEMENT_WINS 行級＋未鎖成本＋金額變 → needsCostConfirm 預覽（零寫入）', async () => {
  const st = mkState() // baseCost 300；行 300→250 → linkedSum 250 ≠ 300
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'STATEMENT_WINS', note: '月結單啱' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.needsCostConfirm, true)
  assert.strictEqual(body.costPreview.baseCost, 300)
  assert.strictEqual(body.costPreview.newLinkedSum, 250)
  assert.strictEqual(body.costPreview.locked, false)
  assert.strictEqual(st.sysLineWrites.length, 0, '預覽零寫入')
  assert.strictEqual(st.ccWrites.length, 0)
  assert.strictEqual(st.line.resolution, null, '行未改')
})

test('STATEMENT_WINS 行級＋未鎖成本＋確認 → 改系統＋成本改做 $250（applyPriceUpdate）', async () => {
  const st = mkState()
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'STATEMENT_WINS', note: '月結單啱', costAdjustConfirmed: true }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.needsCostConfirm, undefined)
  assert.strictEqual(st.sysLineWrites.length, 1)
  assert.strictEqual(st.ccWrites.length, 1)
  assert.strictEqual(st.ccWrites[0].baseCost, 250)
  assert.strictEqual(st.ccWrites[0].finalCost, 250)
  assert.strictEqual(st.ccWrites[0].status, 'PRICED')
  assert.ok(st.audits.find((a) => a.action === 'LAB_DOC_PRICE_UPDATE'))
  assert.ok(st.audits.find((a) => a.action === 'LAB_STATEMENT_ADJUST'))
  assert.strictEqual(st.line.result, 'MATCHED')
})

test('STATEMENT_WINS 行級＋已鎖成本 → 照改系統、成本唔改價（下期調整）', async () => {
  const st = mkState({ cc: { ...mkState().cc, lockedByRunId: 'run-1' } })
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'STATEMENT_WINS', note: '月結單啱' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.needsCostConfirm, undefined)
  assert.strictEqual(st.sysLineWrites.length, 1, '系統照改')
  assert.strictEqual(st.ccWrites.length, 0, '已鎖唔改價')
  assert.ok(body.costPreview, 'costPreview 標記')
  assert.strictEqual(body.costPreview.locked, true)
  assert.strictEqual(st.line.result, 'MATCHED')
})

// ------------------------------------------------------------------
// MANUAL_PAIRED
// ------------------------------------------------------------------

test('MANUAL_PAIRED：範圍外（醫生日唔喺窗）→ 400', async () => {
  const st = mkState()
  st.sysDoc.docDate = new Date('2026-05-01T00:00:00Z')
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'MANUAL_PAIRED', systemDocumentId: SYS_DOC_ID }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 400)
})

test('MANUAL_PAIRED：範圍內、整張比 total 同 → MATCHED', async () => {
  const st = mkState()
  st.line.result = 'MISSING_IN_SYSTEM'
  st.line.matchedDocumentId = null
  st.sysDoc.total = 250 // = line.amount
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'MANUAL_PAIRED', systemDocumentId: SYS_DOC_ID }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.line.result, 'MATCHED')
  assert.strictEqual(st.line.matchBasis, 'MANUAL')
  assert.strictEqual(st.line.matchedDocumentId, SYS_DOC_ID)
  assert.strictEqual(st.line.matchedLineId, null)
})

test('MANUAL_PAIRED：指定系統行 → 分級比較（PRICE_DIFF）', async () => {
  const st = mkState()
  st.sysDoc.lines[0].unitPrice = 120
  st.sysDoc.lines[0].amount = 250
  st.line.result = 'MISSING_IN_SYSTEM'
  st.line.matchedDocumentId = null
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'MANUAL_PAIRED', systemDocumentId: SYS_DOC_ID, systemLineId: SYS_LINE_ID }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  // line qty1×100 vs sys qty1×120 → PRICE_DIFF
  assert.strictEqual(body.line.result, 'PRICE_DIFF')
  assert.strictEqual(st.line.matchedLineId, SYS_LINE_ID)
})

// ------------------------------------------------------------------
// NOT_OURS
// ------------------------------------------------------------------

test('NOT_OURS：無原因 → 400；有原因 → 200 唔改系統', async () => {
  const st = mkState()
  reset(st)
  let r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'NOT_OURS' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 400)
  r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'NOT_OURS', note: 'Lab 打錯醫生' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(st.line.resolution, 'NOT_OURS')
  assert.strictEqual(st.sysLineWrites.length, 0)
})

// ------------------------------------------------------------------
// 權限／IDOR
// ------------------------------------------------------------------

test('T11 口徑：只有 lab_invoice（無 lab_statement）→ 403', async () => {
  const st = mkState()
  reset(st)
  const r = await POST(makeReq(tokenFor(INV_ONLY, 'EMPLOYEE', ['lab_invoice']), { resolution: 'INVOICE_WINS' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 403)
})

test('IDOR：line 唔屬於 section → 404', async () => {
  const st = mkState({ line: { ...mkState().line, sectionId: 'z'.repeat(25) } })
  reset(st)
  const r = await POST(makeReq(tokenFor(OWNER, 'OWNER'), { resolution: 'INVOICE_WINS' }, PATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 404)
})

// ------------------------------------------------------------------
// close-followup
// ------------------------------------------------------------------

const CPATH = `/api/lab-docs/${DOC_ID}/sections/${SEC_ID}/lines/${LINE_ID}/close-followup`

test('close-followup：INVOICE_WINS → 200 寫 followUpClosedAt', async () => {
  const st = mkState({ line: { ...mkState().line, resolution: 'INVOICE_WINS', resolvedAt: new Date() } })
  reset(st)
  const r = await CLOSE(makeReq(tokenFor(OWNER, 'OWNER'), {}, CPATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 200)
  assert.ok(st.line.followUpClosedAt)
  assert.strictEqual(st.line.followUpClosedBy, OWNER)
})

test('close-followup：非 INVOICE_WINS → 400；已關閉 → 409', async () => {
  const st = mkState()
  reset(st)
  let r = await CLOSE(makeReq(tokenFor(OWNER, 'OWNER'), {}, CPATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 400)
  const st2 = mkState({ line: { ...mkState().line, resolution: 'INVOICE_WINS', followUpClosedAt: new Date() } })
  reset(st2)
  r = await CLOSE(makeReq(tokenFor(OWNER, 'OWNER'), {}, CPATH) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: LINE_ID } } as any)
  assert.strictEqual(r.status, 409)
})
