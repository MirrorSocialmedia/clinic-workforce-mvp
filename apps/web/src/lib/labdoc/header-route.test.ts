/**
 * cwm-labdoc P2 — §7.1 確認頭部 route unit（T1/T2 相鄰 + §7.9 守門）
 *
 * 覆蓋：
 *  - 200 happy（NEEDS_REVIEW → CONFIRMED、version+1、audit LAB_DOC_CONFIRM）
 *  - manualAmountEdit：AI 原值 vs 確認值（total／行金額）→ true（F-05）
 *  - version 唔等 → 409（帶人）
 *  - §5.5 擋確認：總數/小計都空 → 400；Σ mismatch → 400；CHEQUE_PRESENT → 400
 *  - 已配對行被刪 → 400（§7.9 先解除）
 *  - 同 lab 同單號 unique violation → 409
 *  - 狀態 gate（EXTRACTING → 400；STATEMENT → 400 P3）
 *  - alias 學習（AI 未認到 lab → 確認後 LabAlias upsert + LAB_ALIAS_LEARN audit）
 *  - auth：401 / 404 / 400 格式 / EMPLOYEE 無 lab_invoice → 403
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { NextRequest } from 'next/server'
import { createRequire } from 'node:module'
import { createToken } from '../auth'

const req2 = createRequire(import.meta.url)
void req2

const OWNER = 'f'.repeat(25)
const EMPLOYEE = 'e'.repeat(25)
const DOC_ID = 'a'.repeat(25)
const LAB_A = 'l'.repeat(25)
const LAB_B = 'q'.repeat(25)
const CLINIC_A = 'c'.repeat(25)
const PROVIDER_A = 'p'.repeat(25)
const LINE_A = 'x'.repeat(25)
const CC_1 = '1'.repeat(25)

// createToken 用 CONFIG.JWT_SECRET（dev fallback 口徑 — 同 P1 route test）
function tokenFor(userId: string, tokenVersion = 0): string {
  return createToken({ userId, role: 'OWNER', clinics: [], tokenVersion })
}
function empToken(tokenVersion = 0): string {
  return createToken({ userId: EMPLOYEE, role: 'EMPLOYEE', clinics: [], tokenVersion })
}
function makeReq(url: string, tok: string | null, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'PUT',
    // requireAuth 讀 cookie 'session'（唔係 Bearer header）
    headers: tok ? { cookie: `session=${tok}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function aiExtracted(over: Record<string, unknown> = {}) {
  return {
    lab: { nameRaw: 'Sodental Ltd', nameCnRaw: null, payeeRaw: 'SODENTAL LTD' },
    billTo: { nameRaw: 'Dr. Chan Clinic', addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: 'Dr. Chan' },
    docNoRaw: 'INV-260805010',
    docNoLabel: 'Invoice No.',
    dateRaw: '05/08/2026',
    date: '2026-08-05',
    deliveryDate: null,
    orderReceivedDate: null,
    statementMonth: null,
    groups: [
      {
        patientNameRaw: 'CHAN',
        patientCodeRaw: 'TY12345',
        labCaseRef: null,
        lines: [
          { description: 'Crown', toothRaw: '16', qty: 1, unitPrice: 100, listPrice: null, discountRaw: null, amount: 100 },
        ],
      },
    ],
    sections: [],
    subtotal: 100,
    total: 100,
    readIssues: [],
    ...over,
  }
}

function makeDoc(over: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    kind: 'INVOICE',
    status: 'NEEDS_REVIEW',
    version: 1,
    labId: LAB_A,
    labBasis: 'MANUAL',
    labNameRaw: null,
    labNameCnRaw: null,
    clinicId: CLINIC_A,
    clinicBasis: null,
    providerId: PROVIDER_A,
    providerBasis: null,
    customerNoRaw: null,
    payeeRaw: 'SODENTAL LTD',
    docNo: 'INV-260805010',
    docNoKind: 'INVOICE_NO',
    docDate: new Date('2026-08-05T00:00:00Z'),
    deliveryDate: null,
    orderReceivedDate: null,
    total: 100,
    subtotal: 100,
    readIssues: [],
    extractedJson: aiExtracted(),
    manualAmountEdit: false,
    uploadedBy: OWNER,
    confirmedBy: null,
    confirmedAt: null,
    uploadedAt: new Date('2026-10-05T00:00:00Z'),
    createdAt: new Date('2026-10-05T00:00:00Z'),
    heartbeatAt: null,
    extractAttempts: 0,
    extractSource: null,
    extractError: null,
    purgeAt: null,
    lines: [
      {
        id: LINE_A,
        documentId: DOC_ID,
        groupIndex: 0,
        lineIndex: 0,
        description: 'Crown',
        toothRaw: '16',
        qty: 1,
        unitPrice: 100,
        listPrice: null,
        discountRaw: null,
        amount: 100,
        isZero: false,
        status: 'UNMATCHED',
        ignoreReason: null,
        costCaseId: null,
        linkType: null,
        patientNameRaw: 'CHAN',
        patientCodeRaw: 'TY12345',
        patientCode: 'TY12345',
        labCaseRef: null,
        matchedBy: null,
        matchedAt: null,
      },
    ],
    ...over,
  }
}

interface TxRecord {
  doc: any
  audits: any[]
  aliasUpserts: any[]
  claimCount: number
  claimThrow?: { code: string }
  lineUpdates: any[]
  lineCreates: any[]
  lineDeletes: any[]
}

function makeFakePrisma(doc: any, txRec: TxRecord) {
  return {
    user: {
      findUnique: async ({ where }: any) =>
        where.id === OWNER
          ? { id: OWNER, name: 'Boss', role: 'OWNER', status: 'ACTIVE', tokenVersion: 0, labs: [], ipAllowlist: null, clinics: [] }
          : where.id === EMPLOYEE
            ? { id: EMPLOYEE, name: 'Emp', role: 'EMPLOYEE', status: 'ACTIVE', tokenVersion: 0, labs: [], ipAllowlist: null, clinics: [] }
            : null,
    },
    clinic: {
      findUnique: async () => ({ id: CLINIC_A, name: '大圍', shortName: 'TW' }),
    },
    lab: {
      findUnique: async () => ({ id: LAB_A, name: 'Sodental', isActive: true }),
    },
    provider: {
      findUnique: async () => ({ id: PROVIDER_A }),
    },
    patientIndex: { findFirst: async () => null },
    costCase: { findMany: async () => [] },
    labDocument: {
      findUnique: async () => ({ ...doc, lines: [...doc.lines] }),
      updateMany: async ({ where }: any) => {
        txRec.claimCount++
        if (txRec.claimThrow) throw txRec.claimThrow
        if (where.version !== doc.version) return { count: 0 }
        return { count: 1 }
      },
      update: async ({ data }: any) => {
        Object.assign(doc, data)
        return {
          ...doc,
          lines: doc.lines,
          lab: { id: doc.labId, name: 'Sodental', isActive: true },
        }
      },
    },
    labDocumentLine: {
      update: async ({ where, data }: any) => {
        txRec.lineUpdates.push({ id: where.id, data })
        const i = doc.lines.findIndex((l: any) => l.id === where.id)
        if (i >= 0) doc.lines[i] = { ...doc.lines[i], ...data }
        return doc.lines[i]
      },
      create: async ({ data }: any) => {
        const created = { id: `new-${txRec.lineCreates.length}`, ...data }
        txRec.lineCreates.push(created)
        doc.lines.push(created)
        return created
      },
      deleteMany: async ({ where }: any) => {
        txRec.lineDeletes.push(where.id.in)
        doc.lines = doc.lines.filter((l: any) => !(where.id.in as string[]).includes(l.id))
        return { count: where.id.in.length }
      },
    },
    auditLog: { create: async (a: any) => txRec.audits.push(a.data) },
    labAlias: {
      upsert: async (a: any) => {
        txRec.aliasUpserts.push(a)
        return a.create
      },
    },
    labCustomerNo: { upsert: async (a: any) => a.create },
    clinicNameAlias: { upsert: async (a: any) => a.create },
    providerNameAlias: { upsert: async (a: any) => a.create },
    $transaction: async (fn: any) => fn(makeFakePrisma(doc, txRec)),
  }
}

let PUT: any
import { prisma } from '../prisma'

const KEYS = [
  'labDocument',
  'labDocumentLine',
  'user',
  'clinic',
  'lab',
  'provider',
  'patientIndex',
  'costCase',
  'auditLog',
  'labAlias',
  'labCustomerNo',
  'clinicNameAlias',
  'providerNameAlias',
  '$transaction',
] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]

before(async () => {
  const mod = await import('../../app/api/lab-docs/[id]/header/route')
  PUT = mod.PUT
})

function resetFake(doc: any): TxRecord {
  const txRec: TxRecord = {
    doc,
    audits: [],
    aliasUpserts: [],
    claimCount: 0,
    lineUpdates: [],
    lineCreates: [],
    lineDeletes: [],
  }
  const fake = makeFakePrisma(doc, txRec)
  for (const k of KEYS) {
    Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
  }
  return txRec
}

const BODY_OK = {
  version: 1,
  groups: [
    {
      groupIndex: 0,
      patientCodeRaw: 'TY12345',
      patientNameRaw: 'CHAN',
      lines: [{ lineId: LINE_A, description: 'Crown', toothRaw: '16', qty: 1, unitPrice: 100, amount: 100 }],
    },
  ],
}

test('§7.1 happy：NEEDS_REVIEW → CONFIRMED、version+1、audit LAB_DOC_CONFIRM', async () => {
  const doc = makeDoc()
  const rec = resetFake(doc)
  const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), BODY_OK) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 200)
  const body = await r.json()
  assert.strictEqual(body.document.status, 'CONFIRMED')
  assert.strictEqual(body.document.version, 2)
  assert.strictEqual(body.document.manualAmountEdit, false)
  assert.strictEqual(rec.claimCount, 1)
  const audit = rec.audits.find((a) => a.action === 'LAB_DOC_CONFIRM')
  assert.ok(audit, '有 LAB_DOC_CONFIRM audit')
  assert.strictEqual(audit.entityId, DOC_ID)
  assert.strictEqual(audit.entity, 'LabDocument')
})

test('§7.1 改行金額+總數 → manualAmountEdit = true（F-05）＋ audit 記 before/after', async () => {
  const doc = makeDoc()
  const rec = resetFake(doc)
  const body = {
    ...BODY_OK,
    total: 110,
    groups: [{ ...BODY_OK.groups[0], lines: [{ ...BODY_OK.groups[0].lines[0], amount: 110 }] }],
  }
  const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), body) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 200)
  const out = await r.json()
  assert.strictEqual(out.document.manualAmountEdit, true)
  const audit = rec.audits.find((a) => a.action === 'LAB_DOC_CONFIRM')
  const after = JSON.parse(audit.afterJson)
  assert.strictEqual(after.total, 110)
  assert.ok(Array.isArray(after.lines) && after.lines.some((l: any) => l.after.amount === 110), '行改動有記')
})

test('§7.1 version 唔等 → 409（帶人）', async () => {
  const doc = makeDoc({ confirmedBy: OWNER })
  const rec = resetFake(doc)
  const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), { ...BODY_OK, version: 99 }) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 409)
  const body = await r.json()
  assert.match(body.error, /改咗|重新載入/)
})

test('§7.1 §5.5 擋確認：total/subtotal 都空 → 400', async () => {
  const doc = makeDoc()
  resetFake(doc)
  const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), { ...BODY_OK, total: null, subtotal: null }) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 400)
  const body = await r.json()
  assert.ok(body.blockers.length > 0)
  assert.match(JSON.stringify(body.blockers), /總數|小計/)
})

test('§7.1 §5.5 擋確認：Σ 行 ≠ total → 400', async () => {
  const doc = makeDoc({ total: 999, subtotal: 999, extractedJson: aiExtracted({ total: 999, subtotal: 999 }) })
  resetFake(doc)
  const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), BODY_OK) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 400)
  const body = await r.json()
  assert.match(JSON.stringify(body.blockers), /差|≠/)
})

test('§7.1 CHEQUE_PRESENT → 400（存底唔应该有已簽名支票）', async () => {
  const doc = makeDoc({ readIssues: ['CHEQUE_PRESENT'] })
  resetFake(doc)
  const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), BODY_OK) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 400)
  const body = await r.json()
  assert.match(JSON.stringify(body.blockers), /支票/)
})

test('§7.9 守門：已 MATCHED 行被刪 → 400（要解除配對）', async () => {
  const doc = makeDoc({
    status: 'PARTIAL',
    lines: [
      { ...makeDoc().lines[0], id: LINE_A, status: 'MATCHED', costCaseId: CC_1, linkType: 'MAIN' },
      { ...makeDoc().lines[0], id: 'y'.repeat(25), lineIndex: 1, description: 'Filling', amount: 20, qty: 1, unitPrice: 20 },
    ],
    total: 120,
    subtotal: 120,
  })
  resetFake(doc)
  // 只交返 UNMATCHED 嗰行（MISS_MATCHED 嗰行）
  const body = {
    version: 1,
    groups: [
      {
        groupIndex: 0,
        patientCodeRaw: 'TY12345',
        lines: [{ description: 'Filling', toothRaw: '11', qty: 1, unitPrice: 20, amount: 20, status: 'UNMATCHED' }],
      },
    ],
  }
  const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), body) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 400)
  const out = await r.json()
  assert.match(out.error, /配對|忽略/)
})

test('§6.4 同 lab 同單號 unique violation → 409', async () => {
  const doc = makeDoc()
  const rec = resetFake(doc)
  rec.claimThrow = { code: 'P2002' }
  const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), BODY_OK) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 409)
  const body = await r.json()
  assert.match(body.error, /單號/)
})

test('§7.1 狀態 gate：EXTRACTING → 400；STATEMENT → 400（P3）', async () => {
  {
    const doc = makeDoc({ status: 'EXTRACTING' })
    resetFake(doc)
    const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), BODY_OK) as any, { params: { id: DOC_ID } } as any)
    assert.strictEqual(r.status, 400)
  }
  {
    const doc = makeDoc({ kind: 'STATEMENT' })
    resetFake(doc)
    const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), BODY_OK) as any, { params: { id: DOC_ID } } as any)
    assert.strictEqual(r.status, 400)
    const body = await r.json()
    assert.match(body.error, /P3/)
  }
})

test('§6.1.3 alias 學習：AI 未認到 lab（MANUAL）→ 確認後 LabAlias upsert + LAB_ALIAS_LEARN audit', async () => {
  const doc = makeDoc()
  const rec = resetFake(doc)
  const body = { ...BODY_OK, labId: LAB_B, labNameRaw: 'Sodental Limited' }
  const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), body) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 200)
  const out = await r.json()
  assert.ok(out.aliases.learned.length >= 1, '有 alias 學習')
  const en = rec.aliasUpserts.find((u: any) => u.where.kind_rawNorm?.kind === 'NAME_EN')
  assert.ok(en, 'NAME_EN upsert')
  assert.strictEqual(en.create.labId, LAB_B)
  assert.match(en.where.kind_rawNorm.rawNorm, /^sodental/)
  const aliasAudit = rec.audits.find((a) => a.action === 'LAB_ALIAS_LEARN')
  assert.ok(aliasAudit, 'LAB_ALIAS_LEARN audit')
})

test('§7.1 MATCHED 行照交（帶 costCaseId）→ 配對保留', async () => {
  const doc = makeDoc({
    status: 'PARTIAL',
    lines: [{ ...makeDoc().lines[0], status: 'MATCHED', costCaseId: CC_1, linkType: 'MAIN' }],
  })
  const rec = resetFake(doc)
  const body = {
    ...BODY_OK,
    groups: [{ ...BODY_OK.groups[0], lines: [{ ...BODY_OK.groups[0].lines[0], status: 'MATCHED', costCaseId: CC_1 }] }],
  }
  const r = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), body) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 200)
  const upd = rec.lineUpdates.find((u) => u.id === LINE_A)
  assert.strictEqual(upd.data.status, 'MATCHED')
  // costCaseId 唔喺 update data = 保留 DB 原有配對（route 唔重寫配對欄）
  assert.strictEqual(upd.data.costCaseId, undefined)
  assert.strictEqual(doc.lines[0].costCaseId, CC_1)
})

test('auth：401 無 token；404 冇 doc；400 格式錯 ID；EMPLOYEE 無 lab_invoice → 403', async () => {
  const doc = makeDoc()
  resetFake(doc)
  assert.strictEqual((await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', null, BODY_OK) as any, { params: { id: DOC_ID } } as any)).status, 401)

  resetFake(makeDoc({ id: 'z'.repeat(25) }))
  assert.strictEqual((await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', tokenFor(OWNER), BODY_OK) as any, { params: { id: DOC_ID } } as any)).status, 404)

  resetFake(doc)
  assert.strictEqual((await PUT(makeReq('http://x/api/lab-docs/bad-id/header', tokenFor(OWNER), BODY_OK) as any, { params: { id: 'bad-id' } } as any)).status, 400)

  // EMPLOYEE 無 lab grant → RBAC matrix 403
  const empDoc = makeDoc()
  const empRec = resetFake(empDoc)
  const e403 = await PUT(makeReq('http://x/api/lab-docs/' + DOC_ID + '/header', empToken(), BODY_OK) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(e403.status, 403)
})

after(() => {
  for (const k of KEYS) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
})
