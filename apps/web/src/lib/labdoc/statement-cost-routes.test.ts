/**
 * cwm-labdoc — 月結單同成本錄入對數：confirm／resolve route unit（fake prisma）
 *
 * 2026-10-11 改：取代舊 invoice 對法嘅 confirm-route／resolve-route 測試。
 * 覆蓋：
 *  confirm：一致直接確認＋文件 RECONCILED；差額要原因（寫入 note）；讀數唔齊要原因；兩段先 RECONCILED；
 *           成本範圍（同 Lab／診所／醫生／到貨月、唔計 VOID）；409／400／403／404
 *  resolve：STOCK 唔計總數＋重新對數；NOT_OURS 要原因；CLEAR；成段備貨（冇診所醫生都 OK、文件 IN_PROGRESS）；
 *           STATEMENT_WINS 擋；已確認擋；IDOR；舊 resolution 值 400
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
const lid = (n: number) => String(n).repeat(25).slice(0, 25)

process.env.JWT_SECRET = process.env.JWT_SECRET || 'stmt-cost-test-secret-0123456789'

function tokenFor(userId: string, role: string, grant: string[] = []): string {
  return jwt.sign({ userId, role, clinics: [], tokenVersion: 0, permissionsJson: { grant } }, process.env.JWT_SECRET, { expiresIn: '1h' })
}
function makeReq(tok: string, path: string, body: unknown = {}): NextRequest {
  return new NextRequest(`http://x${path}`, { method: 'POST', headers: { cookie: `session=${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

interface St {
  doc: any
  sections: any[]
  costs: any[]
  profile: any
  audits: any[]
}

function mkLine(n: number, amount: number, over: Record<string, unknown> = {}) {
  return {
    id: lid(n), sectionId: SEC_ID, lineIndex: n, lineType: 'INVOICE', date: null, amount, qty: null, unitPrice: null,
    agingBucket: null, matchedDocumentId: null, matchedLineId: null, matchBasis: null, result: 'PENDING',
    resolution: null, resolutionNote: null, resolvedBy: null, resolvedAt: null, followUpClosedAt: null, followUpClosedBy: null,
    ...over,
  }
}
function mkCost(id: string, finalCost: number | null, over: Record<string, unknown> = {}) {
  return {
    id, labId: LAB, clinicId: CLINIC, providerId: PROVIDER, periodMonth: '2026-09', status: 'PRICED',
    patientCode: 'TKW001443', itemType: 'Implant', itemTypeOther: null, finalCost, receivedAt: new Date('2026-09-29T00:00:00Z'),
    ...over,
  }
}
function mkSection(id: string, over: Record<string, unknown> = {}) {
  return {
    id, documentId: DOC_ID, sectionIndex: id === SEC_ID ? 0 : 1, clinicId: CLINIC, providerId: PROVIDER,
    statedTotal: null, statedCurrent: null, systemTotal: null, status: 'PENDING', resultJson: null, note: null,
    lines: [mkLine(1, 0), mkLine(2, 1120), mkLine(3, 1680), mkLine(4, 1640), mkLine(5, 1230), mkLine(6, 0)],
    ...over,
  }
}
function mkState(over: Partial<St> = {}): St {
  return {
    doc: { id: DOC_ID, kind: 'STATEMENT', status: 'IN_PROGRESS', statementMonth: '2026-09', labId: LAB, clinicId: null, providerId: null, createdAt: new Date('2026-10-11T00:00:00Z') },
    sections: [mkSection(SEC_ID)],
    costs: [mkCost('c1', 5670)],
    profile: { labId: LAB, statementKind: 'DETAIL' },
    audits: [],
    ...over,
  }
}

const matchWhere = (row: any, where: any): boolean => {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as any
      if ('in' in o && !o.in.includes(row[k])) return false
      if ('not' in o && row[k] === o.not) return false
      if ('notIn' in o && o.notIn.includes(row[k])) return false
      continue
    }
    if (row[k] !== v) return false
  }
  return true
}

function makeFake(state: St): any {
  const secOut = (s: any) => ({ ...s, lines: [...s.lines].sort((a: any, b: any) => a.lineIndex - b.lineIndex).map((l: any) => ({ ...l })) })
  const fake: any = {
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
      findUnique: async ({ where }: any) => (where.id === state.doc.id ? { ...state.doc } : null),
      update: async ({ data }: any) => { Object.assign(state.doc, data); return { ...state.doc } },
      updateMany: async ({ where, data }: any) => {
        if (where.id !== state.doc.id || (where.status && where.status !== state.doc.status)) return { count: 0 }
        Object.assign(state.doc, data)
        return { count: 1 }
      },
    },
    labStatementSection: {
      findFirst: async ({ where }: any) => {
        if (where.document) return null // §8.1 重複查詢
        const s = state.sections.find((x) => x.id === where.id && x.documentId === where.documentId)
        return s ? secOut(s) : null
      },
      findUnique: async ({ where }: any) => {
        const s = state.sections.find((x) => x.id === where.id)
        return s ? { ...secOut(s), document: { ...state.doc } } : null
      },
      findMany: async ({ where }: any) => state.sections.filter((s) => !where?.documentId || s.documentId === where.documentId).map((s) => ({ ...s })),
      updateMany: async ({ where, data }: any) => {
        const s = state.sections.find((x) => x.id === where.id)
        if (!s || (where.documentId && s.documentId !== where.documentId)) return { count: 0 }
        if (where.status?.not && s.status === where.status.not) return { count: 0 }
        Object.assign(s, data)
        return { count: 1 }
      },
    },
    labStatementLine: {
      findFirst: async ({ where }: any) => {
        for (const s of state.sections) {
          const l = s.lines.find((x: any) => x.id === where.id && x.sectionId === where.sectionId && s.id === where.sectionId)
          if (l) return { ...l }
        }
        return null
      },
      findMany: async ({ where }: any) =>
        state.sections.flatMap((s) => s.lines).filter((l: any) => matchWhere(l, where)).map((l: any) => ({ ...l })),
      count: async ({ where }: any) => state.sections.flatMap((s) => s.lines).filter((l: any) => matchWhere(l, where)).length,
      updateMany: async ({ where, data }: any) => {
        let count = 0
        for (const s of state.sections) {
          for (const l of s.lines) {
            const idOk = typeof where.id === 'string' ? l.id === where.id : where.id?.in ? where.id.in.includes(l.id) : true
            if (!idOk || (where.sectionId && l.sectionId !== where.sectionId)) continue
            Object.assign(l, data)
            count++
          }
        }
        return { count }
      },
    },
    costCase: {
      findMany: async ({ where }: any) => state.costs.filter((c) => matchWhere(c, where)).map((c) => ({ ...c })),
      findFirst: async ({ where }: any) => { const c = state.costs.find((x) => matchWhere(x, where)); return c ? { ...c } : null },
    },
    auditLog: { create: async (a: any) => state.audits.push(a.data) },
  }
  fake.$transaction = async (fn: any) => fn(fake)
  return fake
}

const KEYS = ['user', 'labProfile', 'labDocument', 'labStatementSection', 'labStatementLine', 'costCase', 'auditLog', '$transaction'] as const
import { prisma } from '../prisma'
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]

let CONFIRM: any
let RESOLVE: any
let PAIR: any
before(async () => {
  PAIR = (await import('../../app/api/lab-docs/[id]/sections/[sid]/pair/route')).POST
  CONFIRM = (await import('../../app/api/lab-docs/[id]/sections/[sid]/confirm/route')).POST
  RESOLVE = (await import('../../app/api/lab-docs/[id]/sections/[sid]/lines/[lid]/resolve/route')).POST
})
function reset(state: St) {
  const fake = makeFake(state)
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: fake[k], configurable: true, writable: true })
}
after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

const owner = () => tokenFor(OWNER, 'OWNER')
const confirmPath = (sid = SEC_ID) => `/api/lab-docs/${DOC_ID}/sections/${sid}/confirm`
const confirmCall = (st: St, body: unknown = {}, sid = SEC_ID, tok = owner()) => {
  reset(st)
  return CONFIRM(makeReq(tok, confirmPath(sid), body) as any, { params: { id: DOC_ID, sid } } as any)
}
const resolveCall = (st: St, n: number, body: unknown, sid = SEC_ID) => {
  reset(st)
  return RESOLVE(makeReq(owner(), `/api/lab-docs/${DOC_ID}/sections/${sid}/lines/${lid(n)}/resolve`, body) as any, { params: { id: DOC_ID, sid, lid: lid(n) } } as any)
}

// ───────────── confirm ─────────────

test('confirm：同成本錄入一致 → CONFIRMED、文件 RECONCILED、audit 有兩邊總數', async () => {
  const st = mkState()
  const r = await confirmCall(st)
  assert.strictEqual(r.status, 200, JSON.stringify(await r.clone().json()))
  assert.strictEqual(st.sections[0].status, 'CONFIRMED')
  assert.strictEqual(st.sections[0].confirmedBy, OWNER)
  assert.strictEqual(st.doc.status, 'RECONCILED')
  assert.strictEqual(st.sections[0].lines[2].result, 'MATCHED')
  assert.strictEqual(st.sections[0].lines[0].result, 'NOT_APPLICABLE')
  const a = st.audits.filter((x) => x.action === 'LAB_STATEMENT_RECONCILE').pop()
  const aj = JSON.parse(a.afterJson)
  assert.strictEqual(aj.statementTotal, 5670)
  assert.strictEqual(aj.costTotal, 5670)
  assert.strictEqual(aj.totalDiff, 0)
})

test('confirm：成本範圍只計同 Lab／診所／醫生／到貨月、唔計 VOID', async () => {
  const st = mkState({
    costs: [
      mkCost('c1', 5670),
      mkCost('x1', 999, { labId: 'z'.repeat(25) }),
      mkCost('x2', 999, { providerId: 'q'.repeat(25) }),
      mkCost('x3', 999, { periodMonth: '2026-10' }),
      mkCost('x4', 999, { status: 'VOID' }),
    ],
  })
  const r = await confirmCall(st)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(st.sections[0].systemTotal, 5670)
  assert.deepStrictEqual(st.sections[0].resultJson.costs.map((c: any) => c.id), ['c1'])
})

test('confirm：有差額冇原因 → 400 REASON_REQUIRED；有原因 → CONFIRMED＋note', async () => {
  const st = mkState({ costs: [mkCost('c1', 5000)] })
  let r = await confirmCall(st)
  assert.strictEqual(r.status, 400)
  const b = await r.json()
  assert.strictEqual(b.code, 'REASON_REQUIRED')
  assert.strictEqual(b.diff, 670)
  assert.strictEqual(st.sections[0].status, 'DIFF')
  r = await confirmCall(st, { reason: 'Lab 下月補單' })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(st.sections[0].status, 'CONFIRMED')
  assert.strictEqual(st.sections[0].note, 'Lab 下月補單')
})

test('confirm：總數一致但月結單印嘅總數同行加埋唔啱 → 要原因', async () => {
  const st = mkState()
  st.sections[0].statedTotal = 6000
  const r = await confirmCall(st)
  assert.strictEqual(r.status, 400)
  assert.strictEqual((await r.json()).code, 'REASON_REQUIRED')
})

test('confirm：兩段 — 第一段確認後文件未 RECONCILED', async () => {
  const st = mkState({ sections: [mkSection(SEC_ID), mkSection(SEC2_ID, { lines: [] })] })
  const r = await confirmCall(st)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(st.doc.status, 'IN_PROGRESS')
})

test('confirm：已確認 409；SUPERSEDED 409；唔係月結單 400；lab_invoice only 403；分段唔屬呢張單 404', async () => {
  let st = mkState()
  st.sections[0].status = 'CONFIRMED'
  assert.strictEqual((await confirmCall(st)).status, 409)
  st = mkState()
  st.doc.status = 'SUPERSEDED'
  assert.strictEqual((await confirmCall(st)).status, 409)
  st = mkState()
  st.doc.kind = 'INVOICE'
  assert.strictEqual((await confirmCall(st)).status, 400)
  st = mkState()
  assert.strictEqual((await confirmCall(st, {}, SEC_ID, tokenFor(INV_ONLY, 'EMPLOYEE', ['lab_invoice']))).status, 403)
  st = mkState()
  assert.strictEqual((await confirmCall(st, {}, SEC2_ID)).status, 404)
})

test('confirm：未揀診所／醫生而仲有要計嘅行 → 400 NEEDS_ASSIGN', async () => {
  const st = mkState({ sections: [mkSection(SEC_ID, { clinicId: null, providerId: null, status: 'NEEDS_ASSIGN' })] })
  const r = await confirmCall(st)
  assert.strictEqual(r.status, 400)
  assert.strictEqual((await r.json()).code, 'NEEDS_ASSIGN')
})

// ───────────── resolve（行標記）─────────────

test('resolve：STOCK 一行 → 唔計入總數、即刻重新對數、audit', async () => {
  const st = mkState({ costs: [mkCost('c1', 4440)] }) // 5670 − 1230
  const r = await resolveCall(st, 5, { resolution: 'STOCK' })
  assert.strictEqual(r.status, 200)
  const b = await r.json()
  assert.strictEqual(b.reconcile.status, 'OK')
  assert.strictEqual(b.reconcile.statementTotal, 4440)
  assert.strictEqual(st.sections[0].lines[4].resolution, 'STOCK')
  assert.strictEqual(st.sections[0].lines[4].resolvedBy, OWNER)
  assert.strictEqual(st.sections[0].resultJson.stockTotal, 1230)
  assert.ok(st.audits.some((a) => a.action === 'LAB_STATEMENT_RESOLVE'))
})

test('resolve：NOT_OURS 冇原因 → 400；有原因 → 200；CLEAR → 清走', async () => {
  const st = mkState()
  assert.strictEqual((await resolveCall(st, 2, { resolution: 'NOT_OURS' })).status, 400)
  assert.strictEqual((await resolveCall(st, 2, { resolution: 'NOT_OURS', note: '第二間診所' })).status, 200)
  assert.strictEqual(st.sections[0].lines[1].resolution, 'NOT_OURS')
  assert.strictEqual(st.sections[0].lines[1].resolutionNote, '第二間診所')
  assert.strictEqual((await resolveCall(st, 2, { resolution: 'CLEAR' })).status, 200)
  assert.strictEqual(st.sections[0].lines[1].resolution, null)
  assert.strictEqual(st.sections[0].status, 'OK')
})

test('resolve：成段備貨 — 冇診所／醫生都對得到（0 = 0）、文件 NEEDS_REVIEW → IN_PROGRESS', async () => {
  const st = mkState({ sections: [mkSection(SEC_ID, { clinicId: null, providerId: null, status: 'NEEDS_ASSIGN' })] })
  st.doc.status = 'NEEDS_REVIEW'
  const r = await resolveCall(st, 1, { resolution: 'STOCK', applyToAll: true })
  assert.strictEqual(r.status, 200)
  const b = await r.json()
  assert.strictEqual(b.updated, 6)
  assert.strictEqual(b.reconcile.status, 'OK')
  assert.ok(st.sections[0].lines.every((l: any) => l.resolution === 'STOCK'))
  assert.strictEqual(st.sections[0].status, 'OK')
  assert.strictEqual(st.doc.status, 'IN_PROGRESS')
})

test('resolve：STATEMENT_WINS 行 → 409；已確認 → 409；行唔屬呢段 → 404；舊 resolution 值 → 400', async () => {
  let st = mkState()
  st.sections[0].lines[1].resolution = 'STATEMENT_WINS'
  assert.strictEqual((await resolveCall(st, 2, { resolution: 'STOCK' })).status, 409)
  st = mkState()
  st.sections[0].status = 'CONFIRMED'
  assert.strictEqual((await resolveCall(st, 2, { resolution: 'STOCK' })).status, 409)
  st = mkState()
  reset(st)
  const bad = await RESOLVE(makeReq(owner(), `/api/lab-docs/${DOC_ID}/sections/${SEC_ID}/lines/${'z'.repeat(25)}/resolve`, { resolution: 'STOCK' }) as any, { params: { id: DOC_ID, sid: SEC_ID, lid: 'z'.repeat(25) } } as any)
  assert.strictEqual(bad.status, 404)
  st = mkState()
  assert.strictEqual((await resolveCall(st, 2, { resolution: 'INVOICE_WINS' })).status, 400)
})

// ───────────── pair（2026-10-11：人手配對／未配對到） ─────────────

const pairCall = (st: St, body: unknown, sid = SEC_ID) => {
  reset(st)
  return PAIR(makeReq(owner(), `/api/lab-docs/${DOC_ID}/sections/${sid}/pair`, body) as any, { params: { id: DOC_ID, sid } } as any)
}
// 用家個案：$210（INV-26092105）＋ $190（INV-26093005）＝ 成本 $400（「$190 補差價」）；中間隔咗一行 $1,100
const pairState = () => mkState({
  sections: [mkSection(SEC_ID, { lines: [mkLine(1, 210, { result: 'UNPAIRED' }), mkLine(2, 1100, { result: 'MATCHED' }), mkLine(3, 190, { result: 'UNPAIRED' })] })],
  costs: [mkCost('c400', 400), mkCost('c1100', 1100)],
})

test('pair：$210 + $190 人手配成本 $400 → 兩行 MANUAL、重新對數 MATCHED、audit', async () => {
  const st = pairState()
  const r = await pairCall(st, { op: 'PAIR', lineIds: [lid(1), lid(3)], costCaseId: 'c400' })
  assert.strictEqual(r.status, 200)
  const [l1, l2, l3] = st.sections[0].lines
  assert.strictEqual(l1.pairMode, 'MANUAL')
  assert.strictEqual(l3.pairCostCaseId, 'c400')
  assert.strictEqual(l1.result, 'MATCHED')
  assert.strictEqual(l2.result, 'MATCHED')
  assert.strictEqual(l3.result, 'MATCHED')
  const pairs = st.sections[0].resultJson.pairs
  assert.deepStrictEqual(pairs.find((p: any) => p.costCaseId === 'c400'), { costCaseId: 'c400', lineIds: [lid(1), lid(3)], manual: true })
  assert.deepStrictEqual(st.sections[0].resultJson.unpairedCostIds, [])
  assert.ok(st.audits.some((a) => a.action === 'LAB_STATEMENT_PAIR'))
})

test('pair：唔啱數 → 400 AMOUNT_MISMATCH（唔准）；成本唔喺範圍 → 404；成本已配 → 409；$0／付款行 → 400', async () => {
  let st = pairState()
  let r = await pairCall(st, { op: 'PAIR', lineIds: [lid(1)], costCaseId: 'c400' })
  assert.strictEqual(r.status, 400)
  assert.strictEqual((await r.json()).code, 'AMOUNT_MISMATCH')
  assert.strictEqual(st.sections[0].lines[0].pairMode, undefined)

  st = pairState()
  st.costs.push(mkCost('cOther', 400, { providerId: 'q'.repeat(25) }))
  assert.strictEqual((await pairCall(st, { op: 'PAIR', lineIds: [lid(1), lid(3)], costCaseId: 'cOther' })).status, 404)

  st = pairState()
  st.sections[0].lines.push(mkLine(4, 400, { result: 'UNPAIRED', pairMode: 'MANUAL', pairCostCaseId: 'c400' }))
  assert.strictEqual((await pairCall(st, { op: 'PAIR', lineIds: [lid(1), lid(3)], costCaseId: 'c400' })).status, 409)

  st = pairState()
  st.sections[0].lines.push(mkLine(4, 0, { result: 'NOT_APPLICABLE' }))
  assert.strictEqual((await pairCall(st, { op: 'PAIR', lineIds: [lid(4)], costCaseId: 'c400' })).status, 400)
})

test('pair：人手配咗嘅行唔可以直接標備貨（409）；UNPAIR 成組拆開 → NONE、唔再自動劃；AUTO 恢復', async () => {
  const st = pairState()
  assert.strictEqual((await pairCall(st, { op: 'PAIR', lineIds: [lid(1), lid(3)], costCaseId: 'c400' })).status, 200)
  assert.strictEqual((await resolveCall(st, 1, { resolution: 'STOCK' })).status, 409)

  assert.strictEqual((await pairCall(st, { op: 'UNPAIR', lineId: lid(3) })).status, 200)
  const [l1, , l3] = st.sections[0].lines
  assert.strictEqual(l1.pairMode, 'NONE')
  assert.strictEqual(l3.pairMode, 'NONE')
  assert.strictEqual(l1.pairCostCaseId, null)
  assert.strictEqual(l1.result, 'UNPAIRED')
  assert.deepStrictEqual(st.sections[0].resultJson.unpairedCostIds, ['c400'])

  assert.strictEqual((await pairCall(st, { op: 'AUTO', lineId: lid(1) })).status, 200)
  assert.strictEqual(st.sections[0].lines[0].pairMode, null)
  assert.strictEqual((await pairCall(st, { op: 'AUTO', lineId: lid(1) })).status, 409, '冇標未配對到 → 409')
})

test('pair：UNPAIR 系統自動劃錯嘅組 → 拆開，重新對數都唔再劃埋', async () => {
  const st = pairState()
  // 先對一次數：$1,100 自動劃埋 c1100
  assert.strictEqual((await resolveCall(st, 2, { resolution: 'CLEAR' })).status, 200)
  assert.ok(st.sections[0].resultJson.pairs.some((p: any) => p.costCaseId === 'c1100' && !p.manual))
  assert.strictEqual((await pairCall(st, { op: 'UNPAIR', lineId: lid(2) })).status, 200)
  assert.strictEqual(st.sections[0].lines[1].pairMode, 'NONE')
  assert.strictEqual(st.sections[0].lines[1].result, 'UNPAIRED')
  assert.ok(st.sections[0].resultJson.unpairedCostIds.includes('c1100'))
})

test('pair：已確認 → 409；op 唔合法 → 400；lab_invoice only → 403', async () => {
  let st = pairState()
  st.sections[0].status = 'CONFIRMED'
  assert.strictEqual((await pairCall(st, { op: 'PAIR', lineIds: [lid(1), lid(3)], costCaseId: 'c400' })).status, 409)
  st = pairState()
  assert.strictEqual((await pairCall(st, { op: 'MERGE', lineId: lid(1) })).status, 400)
  st = pairState()
  reset(st)
  const r = await PAIR(makeReq(tokenFor(INV_ONLY, 'EMPLOYEE', ['lab_invoice']), `/api/lab-docs/${DOC_ID}/sections/${SEC_ID}/pair`, { op: 'AUTO', lineId: lid(1) }) as any, { params: { id: DOC_ID, sid: SEC_ID } } as any)
  assert.strictEqual(r.status, 403)
})
