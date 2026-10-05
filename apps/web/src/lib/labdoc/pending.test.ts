/**
 * cwm-labdoc P2 CHUNK 5 — §9 待處理（7 類別）unit
 *
 * 覆蓋：
 *  - 純函數：csvGuardCell（公式注入 =+-@/tab/CR／引號包埋）、csvRow、monthRange、visibleCategories
 *  - GET route：7 類別 badge＋items（OWNER 全見）、category 過濾、CSV 匯出（guard 生效）、
 *    400（未知類別／month 格式／id 格式）、401 無 token、LOCKED_ADJUST linkedSum≠baseCost 過濾
 *  - resolve routes（§11 per-doc）：review-amount（200＋audit／400 已覆核／409 版本）、
 *    payee（200 alias 新建／200 已有 alias／409 他 Lab 衝突／400 無 labId／400 suspicious 未實作）、
 *    403 無 lab_statement、400 body 驗證、404
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { NextRequest } from 'next/server'
import { createRequire } from 'node:module'

const req2 = createRequire(import.meta.url)
const jwt: any = req2('jsonwebtoken')

import { CONFIG } from '../config'

// ★ 簽 token 用 CONFIG.JWT_SECRET（verifyToken 同一個 load-time constant）—
//   唔好信 process.env（esbuild hoist import 先於 env 賦值 → 簽驗唔同 secret = 全 401）

const OWNER = 'f'.repeat(25)
const EMP_INV = 'e'.repeat(25)
const DOC_A = 'a'.repeat(25)
const DOC_B = 'b'.repeat(25)
const LINE_A = 'l'.repeat(25)
const COST_A = 'c'.repeat(25)
const COST_LOCKED_OK = 'd'.repeat(25)
const COST_LOCKED_EQ = 'e2'.padEnd(25, '0')
const LAB_A = 'g'.repeat(25)
const LAB_B = 'h'.repeat(25)
const CLINIC_A = 'k'.repeat(25)

function tokenFor(userId: string, role: string, grant: string[] = []): string {
  return jwt.sign({ userId, role, clinics: [], tokenVersion: 0 }, CONFIG.JWT_SECRET, { expiresIn: '1h' })
}
function makeReq(url: string, method: string, tok: string | null, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: tok ? { cookie: `session=${tok}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

import { prisma } from '../prisma'
import { csvGuardCell, csvRow, monthRange, visibleCategories } from './pending'
import { GET as pendingGET } from '../../app/api/lab-docs/pending/route'
import { POST as reviewAmountPOST } from '../../app/api/lab-docs/[id]/review-amount/route'
import { POST as payeePOST } from '../../app/api/lab-docs/[id]/payee/route'

// ─── 純函數 ─────────────────────────────────────────────────────────

test('csvGuardCell：公式注入前綴 = + - @ / tab / CR → 前加 ’', () => {
  assert.strictEqual(csvGuardCell('=CMD()'), "'=CMD()")
  assert.strictEqual(csvGuardCell('+1+2'), "'+1+2")
  assert.strictEqual(csvGuardCell('-5'), "'-5")
  assert.strictEqual(csvGuardCell('@SUM(A1)'), "'@SUM(A1)")
  assert.strictEqual(csvGuardCell('\tcmd'), "'\tcmd")
  assert.strictEqual(csvGuardCell('\r\nx'), "'\r\nx")
})

test('csvGuardCell：普通值原樣；逗號／引號／換行 → 引號包埋（內引號雙寫）；null/undefined → 空', () => {
  assert.strictEqual(csvGuardCell('abc'), 'abc')
  assert.strictEqual(csvGuardCell(123), '123')
  assert.strictEqual(csvGuardCell('a,b'), '"a,b"')
  assert.strictEqual(csvGuardCell('say "hi"'), '"say ""hi"""')
  assert.strictEqual(csvGuardCell('line\nbreak'), '"line\nbreak"')
  assert.strictEqual(csvGuardCell(null), '')
  assert.strictEqual(csvGuardCell(undefined), '')
})

test('csvRow：全欄經 csvGuardCell', () => {
  assert.strictEqual(csvRow(['a', '=x', null, 'q"z']), 'a,\'=x,,"q""z"')
})

test('monthRange：YYYY-MM → [月初, 下月初) UTC；格式錯 → null', () => {
  const r = monthRange('2026-09')
  assert.ok(r)
  assert.strictEqual(r.gte.toISOString(), '2026-09-01T00:00:00.000Z')
  assert.strictEqual(r.lt.toISOString(), '2026-10-01T00:00:00.000Z')
  assert.strictEqual(monthRange('2026-13'), null)
  assert.strictEqual(monthRange('2026-0'), null)
  assert.strictEqual(monthRange('2026-9'), null)
  assert.strictEqual(monthRange('banana'), null)
})

test('visibleCategories：按類別權限過濾', () => {
  assert.deepStrictEqual(visibleCategories(['lab_invoice']).sort(), [
    'EXTRACT_FAILED', 'LOCKED_ADJUST', 'NOT_RECEIVED', 'RECEIVED_NO_INVOICE', 'UNMATCHED_LINE',
  ])
  assert.deepStrictEqual(visibleCategories(['lab_statement']).sort(), ['AMOUNT_REVIEW', 'NEW_PAYEE'])
  assert.deepStrictEqual(visibleCategories(['provider_payout']), ['LOCKED_ADJUST'])
  assert.strictEqual(visibleCategories([]).length, 0)
})

// ─── fake prisma harness ────────────────────────────────────────────

interface GetState {
  unmatchLines: any[]
  costs: any[]
  docs: any[]
}

function mkCost(over: Record<string, unknown> = {}): any {
  return {
    id: COST_A,
    category: 'LAB',
    status: 'PRICED',
    labId: LAB_A,
    clinicId: CLINIC_A,
    providerId: null,
    patientCode: 'TW0001',
    finalCost: 500,
    baseCost: 500,
    orderedAt: new Date('2026-09-01T00:00:00Z'),
    receivedAt: null,
    labInvoiceLinked: false,
    lockedByRunId: null,
    periodMonth: '2026-09',
    lab: { name: 'Sodental' },
    labLines: [],
    ...over,
  }
}

function matchCost(c: any, where: any): boolean {
  if (c.category !== where.category) return false
  if (where.status?.not && c.status === where.status.not) return false
  if (where.labId && c.labId !== where.labId) return false
  if (where.clinicId !== undefined) {
    if (typeof where.clinicId === 'object' && where.clinicId.in && !where.clinicId.in.includes(c.clinicId)) return false
    if (typeof where.clinicId === 'string' && c.clinicId !== where.clinicId) return false
  }
  if (where.providerId && c.providerId !== where.providerId) return false
  if (where.periodMonth && c.periodMonth !== where.periodMonth) return false
  if (where.labInvoiceLinked !== undefined && !!c.labInvoiceLinked !== !!where.labInvoiceLinked) return false
  if (where.receivedAt === null && c.receivedAt !== null) return false
  if (where.receivedAt?.lte && !(c.receivedAt instanceof Date && c.receivedAt <= where.receivedAt.lte)) return false
  if (where.lockedByRunId?.not === null && c.lockedByRunId === null) return false
  return true
}

function matchDoc(d: any, where: any): boolean {
  if (where.kind && d.kind !== where.kind) return false
  if (where.status === 'EXTRACT_FAILED' && d.status !== 'EXTRACT_FAILED') return false
  if (where.status?.notIn && where.status.notIn.includes(d.status)) return false
  if (where.status?.in && !where.status.in.includes(d.status)) return false
  if (where.status?.not && d.status === where.status.not) return false
  if (where.labId && d.labId !== where.labId) return false
  if (where.clinicId !== undefined) {
    if (typeof where.clinicId === 'object' && where.clinicId.in && !where.clinicId.in.includes(d.clinicId)) return false
    if (typeof where.clinicId === 'string' && d.clinicId !== where.clinicId) return false
  }
  if (where.providerId && d.providerId !== where.providerId) return false
  if (where.docDate !== undefined && !(d.docDate instanceof Date && d.docDate >= where.docDate.gte && d.docDate < where.docDate.lt)) return false
  if (where.updatedAt?.lte && !(d.updatedAt instanceof Date && d.updatedAt <= where.updatedAt.lte)) return false
  if (where.manualAmountEdit !== undefined && d.manualAmountEdit !== where.manualAmountEdit) return false
  if (where.amountReviewedAt === null && d.amountReviewedAt !== null) return false
  if (where.payeeIsNew !== undefined && d.payeeIsNew !== where.payeeIsNew) return false
  return true
}

function makeGetFake(state: GetState, users: any[] = []) {
  return {
    user: {
      findUnique: async ({ where }: any) => users.find((u) => u.id === where.id) ?? null,
    },
    labDocumentLine: {
      findMany: async ({ where }: any) =>
        state.unmatchLines
          .filter((l) => l.status === where.status && matchDoc(l.document, where.document))
          .slice(0, 500),
      count: async ({ where }: any) =>
        state.unmatchLines.filter((l) => l.status === where.status && matchDoc(l.document, where.document)).length,
    },
    costCase: {
      findMany: async ({ where, take }: any) => state.costs.filter((c) => matchCost(c, where)).slice(0, take ?? 1000),
      count: async ({ where }: any) => state.costs.filter((c) => matchCost(c, where)).length,
    },
    labDocument: {
      findMany: async ({ where, take }: any) => state.docs.filter((d) => matchDoc(d, where)).slice(0, take ?? 500),
      count: async ({ where }: any) => state.docs.filter((d) => matchDoc(d, where)).length,
    },
  }
}

const OWNER_USER = { id: OWNER, status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [], permissionsJson: null }
const EMP_INV_USER = {
  id: EMP_INV,
  status: 'ACTIVE',
  tokenVersion: 0,
  ipAllowlist: null,
  clinics: [],
  permissionsJson: JSON.stringify({ grant: ['lab_invoice'], deny: [] }),
}

let savedPrisma: Record<string, any> = {}

before(() => {
  for (const k of ['user', 'labDocumentLine', 'costCase', 'labDocument', 'labAlias', 'auditLog']) {
    savedPrisma[k] = (prisma as any)[k]
  }
})

after(() => {
  for (const [k, v] of Object.entries(savedPrisma)) {
    if (v !== undefined) Object.defineProperty(prisma, k, { value: v, configurable: true, writable: true })
  }
})

function installGetFake(state: GetState, users: any[] = [OWNER_USER]) {
  Object.defineProperty(prisma, 'user', {
    value: { findUnique: async ({ where }: any) => users.find((u) => u.id === where.id) ?? null },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(prisma, 'labDocumentLine', { value: makeGetFake(state).labDocumentLine, configurable: true, writable: true })
  Object.defineProperty(prisma, 'costCase', { value: makeGetFake(state).costCase, configurable: true, writable: true })
  Object.defineProperty(prisma, 'labDocument', { value: makeGetFake(state).labDocument, configurable: true, writable: true })
}

// ─── GET /api/lab-docs/pending ──────────────────────────────────────

test('GET pending（OWNER）：7 類別 badge＋items；LOCKED_ADJUST 只計 linkedSum≠baseCost', async () => {
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000)
  const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000)
  const state: GetState = {
    unmatchLines: [
      {
        id: LINE_A,
        status: 'UNMATCHED',
        description: 'Crown Zirconia',
        amount: 560,
        patientCode: 'TW007159',
        document: {
          id: DOC_A, docNo: 'TXT-1', docDate: new Date('2026-09-10T00:00:00Z'),
          updatedAt: fiveDaysAgo, clinicId: CLINIC_A, providerId: null, lab: { name: 'Sodental' },
          status: 'CONFIRMED', kind: 'INVOICE', labId: LAB_A,
        },
      },
      {
        // 2 日前（未到 3 日）→ 唔計
        id: 'l2'.padEnd(25, '0'),
        status: 'UNMATCHED',
        description: 'Fresh',
        amount: 100,
        patientCode: null,
        document: {
          id: DOC_B, docNo: 'TXT-2', docDate: new Date('2026-09-10T00:00:00Z'),
          updatedAt: new Date(Date.now() - 2 * 86_400_000), clinicId: CLINIC_A, providerId: null,
          lab: { name: 'Sodental' }, status: 'CONFIRMED', kind: 'INVOICE', labId: LAB_A,
        },
      },
    ],
    costs: [
      mkCost({ id: COST_A, labInvoiceLinked: true, receivedAt: null, orderedAt: new Date('2026-09-01T00:00:00Z') }),
      mkCost({
        id: 'c2'.padEnd(25, '0'), labInvoiceLinked: false,
        receivedAt: twentyDaysAgo, finalCost: 300,
      }),
      mkCost({
        id: COST_LOCKED_OK, lockedByRunId: 'r'.repeat(25), baseCost: 500,
        labLines: [{ amount: 520 }], // linkedSum 520 ≠ 500 → 計
      }),
      mkCost({
        id: COST_LOCKED_EQ, lockedByRunId: 'r'.repeat(25), baseCost: 500,
        labLines: [{ amount: 500 }], // 相等 → 唔計
      }),
    ],
    docs: [
      {
        id: DOC_A, kind: 'INVOICE', status: 'CONFIRMED', labId: LAB_A, clinicId: CLINIC_A, providerId: null,
        docNo: 'TXT-1', docDate: new Date('2026-09-10T00:00:00Z'), total: 1280,
        manualAmountEdit: true, amountReviewedAt: null, payeeIsNew: false,
        updatedAt: fiveDaysAgo, createdAt: new Date('2026-09-10T00:00:00Z'),
        lab: { name: 'Sodental' }, extractError: null, extractAttempts: 0,
      },
      {
        id: DOC_B, kind: 'INVOICE', status: 'EXTRACT_FAILED', labId: null, clinicId: CLINIC_A, providerId: null,
        docNo: null, docDate: null, total: null,
        manualAmountEdit: false, amountReviewedAt: null, payeeIsNew: true,
        updatedAt: fiveDaysAgo, createdAt: new Date('2026-09-10T00:00:00Z'),
        lab: null, extractError: '=CMD(); upstream', extractAttempts: 3, payeeRaw: 'HONESTY GIFTS INT\'L LIMITED',
      },
    ],
  }
  installGetFake(state)

  const res = await pendingGET(makeReq('http://x/api/lab-docs/pending', 'GET', tokenFor(OWNER, 'OWNER')))
  assert.strictEqual(res.status, 200)
  const body: any = await res.json()
  assert.strictEqual(body.categories.length, 7)
  const byKey = Object.fromEntries(body.categories.map((c: any) => [c.key, c]))
  assert.strictEqual(byKey.UNMATCHED_LINE.count, 1, '只有 5 日嗰行')
  assert.strictEqual(byKey.UNMATCHED_LINE.items[0].id, LINE_A)
  assert.strictEqual(byKey.UNMATCHED_LINE.items[0].docId, DOC_A)
  assert.ok(byKey.UNMATCHED_LINE.items[0].days >= 5)
  assert.strictEqual(byKey.NOT_RECEIVED.count, 1)
  assert.strictEqual(byKey.RECEIVED_NO_INVOICE.count, 1)
  assert.strictEqual(byKey.RECEIVED_NO_INVOICE.items[0].days >= 14, true)
  assert.strictEqual(byKey.LOCKED_ADJUST.count, 1, '只計 linkedSum≠baseCost')
  assert.ok(byKey.LOCKED_ADJUST.items[0].extra.includes('diff=20'))
  assert.strictEqual(byKey.AMOUNT_REVIEW.count, 1)
  assert.strictEqual(byKey.NEW_PAYEE.count, 1)
  assert.strictEqual(byKey.NEW_PAYEE.items[0].extra, "HONESTY GIFTS INT'L LIMITED")
  assert.strictEqual(byKey.EXTRACT_FAILED.count, 1)
  assert.strictEqual(body.total, 7)
})

test('GET pending：category 過濾＋csv 匯出（公式注入守門）＋400 參數驗證＋401', async () => {
  const state: GetState = {
    unmatchLines: [],
    costs: [],
    docs: [
      {
        id: DOC_B, kind: 'INVOICE', status: 'EXTRACT_FAILED', labId: null, clinicId: CLINIC_A, providerId: null,
        docNo: 'D-1', docDate: null, total: null,
        manualAmountEdit: false, amountReviewedAt: null, payeeIsNew: false,
        updatedAt: new Date(), createdAt: new Date(),
        lab: null, extractError: '=CMD(); x', extractAttempts: 2,
      },
    ],
  }
  installGetFake(state)

  // category 過濾
  const r1 = await pendingGET(makeReq('http://x/api/lab-docs/pending?category=extract_failed', 'GET', tokenFor(OWNER, 'OWNER')))
  const b1: any = await r1.json()
  assert.strictEqual(r1.status, 200)
  assert.strictEqual(b1.categories.length, 1)
  assert.strictEqual(b1.categories[0].key, 'EXTRACT_FAILED')

  // CSV（OWNER 有 lab_statement）
  // 註：Response.text() 嘅 UTF-8 decoder 會食 leading BOM（spec 行為）→ 用 arrayBuffer 核 byte
  const r2 = await pendingGET(makeReq('http://x/api/lab-docs/pending?format=csv', 'GET', tokenFor(OWNER, 'OWNER')))
  assert.strictEqual(r2.status, 200)
  assert.ok((r2.headers.get('content-type') ?? '').includes('text/csv'))
  const buf = new Uint8Array(await r2.arrayBuffer())
  assert.strictEqual(buf[0], 0xEF)
  assert.strictEqual(buf[1], 0xBB)
  assert.strictEqual(buf[2], 0xBF, 'UTF-8 BOM')
  const csv = new TextDecoder('utf-8').decode(buf)
  assert.ok(csv.includes("'=CMD(); x"), 'extractError 以 = 開頭 → 前加 ’')
  assert.ok(csv.includes('category,id,refType'))

  // 400：未知類別
  const r3 = await pendingGET(makeReq('http://x/api/lab-docs/pending?category=BOGUS', 'GET', tokenFor(OWNER, 'OWNER')))
  assert.strictEqual(r3.status, 400)
  // 400：month 格式
  const r4 = await pendingGET(makeReq('http://x/api/lab-docs/pending?month=2026-9', 'GET', tokenFor(OWNER, 'OWNER')))
  assert.strictEqual(r4.status, 400)
  // 400：clinicId 格式（短 id）
  const r5 = await pendingGET(makeReq('http://x/api/lab-docs/pending?clinicId=abc', 'GET', tokenFor(OWNER, 'OWNER')))
  assert.strictEqual(r5.status, 400)
  // 401：無 token
  const r6 = await pendingGET(makeReq('http://x/api/lab-docs/pending', 'GET', null))
  assert.strictEqual(r6.status, 401)
})

test('GET pending：EMPLOYEE 只有 lab_invoice → 睇唔到 lab_statement 兩類；CSV 403', async () => {
  const state: GetState = { unmatchLines: [], costs: [mkCost({ id: COST_A, labInvoiceLinked: true, receivedAt: null })], docs: [] }
  installGetFake(state, [OWNER_USER, EMP_INV_USER])

  const res = await pendingGET(makeReq('http://x/api/lab-docs/pending', 'GET', tokenFor(EMP_INV, 'EMPLOYEE', ['lab_invoice'])))
  assert.strictEqual(res.status, 200)
  const body: any = await res.json()
  const keys = body.categories.map((c: any) => c.key)
  assert.ok(!keys.includes('AMOUNT_REVIEW'), 'lab_statement 類唔應該出現')
  assert.ok(!keys.includes('NEW_PAYEE'))
  assert.ok(keys.includes('NOT_RECEIVED'))
  assert.strictEqual(body.total, 1)

  const csv = await pendingGET(makeReq('http://x/api/lab-docs/pending?format=csv', 'GET', tokenFor(EMP_INV, 'EMPLOYEE', ['lab_invoice'])))
  assert.strictEqual(csv.status, 403)
})


// ─── POST /api/lab-docs/:id/review-amount ＋ /:id/payee（§11 per-doc resolve）────

interface ResolveState {
  doc: any
  alias: any | null
  audits: any[]
  updated: boolean
}

function mkResolveDoc(over: Record<string, unknown> = {}): any {
  return {
    id: DOC_A,
    labId: LAB_A,
    clinicId: CLINIC_A,
    payeeRaw: "HONESTY GIFTS INT'L LIMITED",
    manualAmountEdit: true,
    amountReviewedAt: null,
    status: 'CONFIRMED',
    version: 3,
    payeeIsNew: true,
    ...over,
  }
}

function makeResolveFake(state: ResolveState, users: any[] = [OWNER_USER]) {
  return {
    user: { findUnique: async ({ where }: any) => users.find((u) => u.id === where.id) ?? null },
    labDocument: {
      findUnique: async ({ where }: any) => (where.id === state.doc.id ? { ...state.doc } : null),
      updateMany: async ({ where, data }: any) => {
        if (where.id !== state.doc.id) return { count: 0 }
        if (where.version !== undefined && state.doc.version !== where.version) return { count: 0 }
        if (where.amountReviewedAt === null && state.doc.amountReviewedAt !== null) return { count: 0 }
        if (where.payeeIsNew === true && state.doc.payeeIsNew !== true) return { count: 0 }
        if (data.version?.increment) state.doc.version += data.version.increment
        if (data.amountReviewedAt) state.doc.amountReviewedAt = data.amountReviewedAt
        if (data.amountReviewedBy !== undefined) state.doc.amountReviewedBy = data.amountReviewedBy
        if (data.payeeIsNew === false) state.doc.payeeIsNew = false
        state.updated = true
        return { count: 1 }
      },
    },
    labAlias: {
      findFirst: async () => state.alias,
      create: async ({ data }: any) => {
        state.alias = { id: 'x'.repeat(25), labId: data.labId, kind: data.kind, rawNorm: data.rawNorm }
        return state.alias
      },
      deleteMany: async () => { state.alias = null; return { count: 1 } },
    },
    auditLog: {
      create: async ({ data }: any) => { state.audits.push(data); return { id: '1' } },
    },
  }
}

function installResolveFake(state: ResolveState, users: any[] = [OWNER_USER]) {
  const fake = makeResolveFake(state, users)
  for (const k of ['user', 'labDocument', 'labAlias', 'auditLog'] as const) {
    Object.defineProperty(prisma, k, { value: fake[k], configurable: true, writable: true })
  }
}

const paramsA = { id: DOC_A }

test('review-amount：200＋amountReviewedAt＋audit LAB_DOC_AMOUNT_REVIEW', async () => {
  const state: ResolveState = { doc: mkResolveDoc(), alias: null, audits: [], updated: false }
  installResolveFake(state)
  const res = await reviewAmountPOST(makeReq(`http://x/api/lab-docs/${DOC_A}/review-amount`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3 }), { params: paramsA })
  assert.strictEqual(res.status, 200)
  const body: any = await res.json()
  assert.strictEqual(body.ok, true)
  assert.strictEqual(state.doc.amountReviewedAt instanceof Date, true)
  assert.strictEqual(state.doc.amountReviewedBy, OWNER)
  assert.strictEqual(state.doc.version, 4)
  assert.strictEqual(state.audits.length, 1)
  assert.strictEqual(state.audits[0].action, 'LAB_DOC_AMOUNT_REVIEW')
  assert.strictEqual(state.audits[0].entity, 'LabDocument')
  assert.strictEqual(state.audits[0].entityId, DOC_A)
})

test('review-amount：400 唔係待覆核（已覆核／冇改數）；409 版本衝突；400 無 version', async () => {
  // 已覆核
  {
    const state: ResolveState = { doc: mkResolveDoc({ amountReviewedAt: new Date() }), alias: null, audits: [], updated: false }
    installResolveFake(state)
    const r = await reviewAmountPOST(makeReq(`http://x/api/lab-docs/${DOC_A}/review-amount`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3 }), { params: paramsA })
    assert.strictEqual(r.status, 400)
  }
  // 冇改過數
  {
    const state: ResolveState = { doc: mkResolveDoc({ manualAmountEdit: false }), alias: null, audits: [], updated: false }
    installResolveFake(state)
    const r = await reviewAmountPOST(makeReq(`http://x/api/lab-docs/${DOC_A}/review-amount`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3 }), { params: paramsA })
    assert.strictEqual(r.status, 400)
  }
  // 版本衝突
  {
    const state: ResolveState = { doc: mkResolveDoc(), alias: null, audits: [], updated: false }
    installResolveFake(state)
    const r = await reviewAmountPOST(makeReq(`http://x/api/lab-docs/${DOC_A}/review-amount`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 99 }), { params: paramsA })
    assert.strictEqual(r.status, 409)
  }
  // 無 version
  {
    const state: ResolveState = { doc: mkResolveDoc(), alias: null, audits: [], updated: false }
    installResolveFake(state)
    const r = await reviewAmountPOST(makeReq(`http://x/api/lab-docs/${DOC_A}/review-amount`, 'POST', tokenFor(OWNER, 'OWNER'), {}), { params: paramsA })
    assert.strictEqual(r.status, 400)
  }
})

test('payee：200 新建 alias（rawNorm 正規化）＋payeeIsNew=false＋audit LAB_DOC_PAYEE', async () => {
  const state: ResolveState = { doc: mkResolveDoc(), alias: null, audits: [], updated: false }
  installResolveFake(state)
  const res = await payeePOST(makeReq(`http://x/api/lab-docs/${DOC_A}/payee`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3 }), { params: paramsA })
  assert.strictEqual(res.status, 200)
  const body: any = await res.json()
  assert.strictEqual(body.ok, true)
  assert.strictEqual(body.aliasCreated, true)
  assert.strictEqual(state.alias?.kind, 'PAYEE')
  assert.strictEqual(state.alias?.rawNorm, 'honestygiftsintl', 'normLabName 去 limited/標點')
  assert.strictEqual(state.alias?.labId, LAB_A)
  assert.strictEqual(state.doc.payeeIsNew, false)
  assert.strictEqual(state.doc.version, 4)
  assert.strictEqual(state.audits[0]?.action, 'LAB_DOC_PAYEE')
})

test('payee：200 alias 已存在（同一 Lab）— aliasCreated=false；409 他 Lab 佔用', async () => {
  {
    const state: ResolveState = { doc: mkResolveDoc(), alias: { id: 'x'.repeat(25), labId: LAB_A, kind: 'PAYEE', rawNorm: 'honestygiftsintl' }, audits: [], updated: false }
    installResolveFake(state)
    const r = await payeePOST(makeReq(`http://x/api/lab-docs/${DOC_A}/payee`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3 }), { params: paramsA })
    assert.strictEqual(r.status, 200)
    const b: any = await r.json()
    assert.strictEqual(b.aliasCreated, false)
    assert.strictEqual(state.doc.payeeIsNew, false)
  }
  {
    const state: ResolveState = { doc: mkResolveDoc(), alias: { id: 'x'.repeat(25), labId: LAB_B, kind: 'PAYEE', rawNorm: 'honestygiftsintl' }, audits: [], updated: false }
    installResolveFake(state)
    const r = await payeePOST(makeReq(`http://x/api/lab-docs/${DOC_A}/payee`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3 }), { params: paramsA })
    assert.strictEqual(r.status, 409)
    assert.strictEqual(state.doc.payeeIsNew, true, '衝突 → doc 唔變')
    assert.strictEqual(state.alias?.labId, LAB_B, '衝突 → 唔新建 alias')
  }
})

test('payee：400 無 labId／400 無 payeeRaw；404 單據唔存在；400 無 version；400 action=suspicious（P2 未實作）', async () => {
  {
    const state: ResolveState = { doc: mkResolveDoc({ labId: null }), alias: null, audits: [], updated: false }
    installResolveFake(state)
    const r = await payeePOST(makeReq(`http://x/api/lab-docs/${DOC_A}/payee`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3 }), { params: paramsA })
    assert.strictEqual(r.status, 400)
  }
  {
    const state: ResolveState = { doc: mkResolveDoc({ payeeRaw: null }), alias: null, audits: [], updated: false }
    installResolveFake(state)
    const r = await payeePOST(makeReq(`http://x/api/lab-docs/${DOC_A}/payee`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3 }), { params: paramsA })
    assert.strictEqual(r.status, 400)
  }
  {
    // 404：doc 唔存在（fake 只認 DOC_A；用另一 25 字 id）
    const state: ResolveState = { doc: mkResolveDoc(), alias: null, audits: [], updated: false }
    installResolveFake(state)
    const r = await payeePOST(makeReq(`http://x/api/lab-docs/${'z'.repeat(25)}/payee`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3 }), { params: { id: 'z'.repeat(25) } })
    assert.strictEqual(r.status, 404)
  }
  {
    const state: ResolveState = { doc: mkResolveDoc(), alias: null, audits: [], updated: false }
    installResolveFake(state)
    const r1 = await payeePOST(makeReq(`http://x/api/lab-docs/${DOC_A}/payee`, 'POST', tokenFor(OWNER, 'OWNER'), {}), { params: paramsA })
    assert.strictEqual(r1.status, 400)
    // 400：suspicious = P2 未實作（schema 無欄）
    const r2 = await payeePOST(makeReq(`http://x/api/lab-docs/${DOC_A}/payee`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3, action: 'suspicious' }), { params: paramsA })
    assert.strictEqual(r2.status, 400)
    // 400：未知 action
    const r3 = await payeePOST(makeReq(`http://x/api/lab-docs/${DOC_A}/payee`, 'POST', tokenFor(OWNER, 'OWNER'), { version: 3, action: 'bogus' }), { params: paramsA })
    assert.strictEqual(r3.status, 400)
  }
})

test('review-amount／payee：401 無 token；403 EMPLOYEE 無 lab_statement', async () => {
  const state: ResolveState = { doc: mkResolveDoc(), alias: null, audits: [], updated: false }
  installResolveFake(state, [OWNER_USER, EMP_INV_USER])

  const r1 = await reviewAmountPOST(makeReq(`http://x/api/lab-docs/${DOC_A}/review-amount`, 'POST', null, { version: 3 }), { params: paramsA })
  assert.strictEqual(r1.status, 401)

  const r2 = await payeePOST(makeReq(`http://x/api/lab-docs/${DOC_A}/payee`, 'POST', tokenFor(EMP_INV, 'EMPLOYEE', ['lab_invoice']), { version: 3 }), { params: paramsA })
  assert.strictEqual(r2.status, 403)
})
