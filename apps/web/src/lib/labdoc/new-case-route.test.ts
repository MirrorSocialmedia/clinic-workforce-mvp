/**
 * cwm-labdoc P2 — §7.6 新增成本 route unit（T4 冪等 + 預填 + PII）
 *
 * 覆蓋：
 *  - 201 成功：baseCost = 分組合計、finalCost = baseCost、PRICED、MANUAL、labInvoiceLinked、
 *    orderedAt = orderReceivedDate ?? docDate、labOrderNo = 分組行 labCaseRef、
 *    patientName = PatientIndex 系統姓名（route 回應唔回傳 patientName；audit afterJson 唔記 patientName）
 *  - T4：同 key 同 hash 重放 → 200 replayed:true（costCase.create 只係 1 次）
 *  - T4：同 key 唔同 hash → 409；IN_PROGRESS + 同 hash → 409
 *  - 400：idempotencyKey 格式、patientCodeNorm 格式（純數字無前綴）、itemType 必填、
 *    分組 code 唔符、單據未確認、未確認診所、分組冇行
 *  - 401 無 token；403 EMPLOYEE 無 lab_invoice；404 冇單據；400 壞 doc id
 *  - providerOverride
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
const LAB_1 = 'l'.repeat(25)
const CLINIC_1 = 'c1'.padEnd(25, '0')
const PROV_1 = 'p'.repeat(25)
const PROV_2 = 'r'.repeat(25)

process.env.JWT_SECRET = process.env.JWT_SECRET || 'p2-newcase-test-secret-0123456789'

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

interface WriteLogRow {
  idempotencyKey: string
  requestHash: string
  route: string
  status: string
  responseJson: unknown
  createdBy: string
}
interface State {
  doc: any | null
  clinics: Array<{ id: string; name: string; shortName: string | null }>
  providers: Array<{ id: string; name: string }>
  patientName: string | null
  created: any[]
  audits: any[]
  writeLog: Map<string, WriteLogRow>
}

function mkDoc(over: Record<string, unknown> = {}): any {
  return {
    id: DOC_ID,
    kind: 'INVOICE',
    status: 'CONFIRMED',
    labId: LAB_1,
    clinicId: CLINIC_1,
    providerId: PROV_1,
    docNo: 'INV-1',
    orderReceivedDate: new Date('2026-09-01T00:00:00Z'),
    docDate: new Date('2026-09-05T00:00:00Z'),
    lines: [
      {
        id: 'l1'.padEnd(25, '0'),
        groupIndex: 0,
        lineIndex: 0,
        description: 'Crown',
        amount: 300,
        isZero: false,
        status: 'UNMATCHED',
        patientCode: 'TW007159',
        patientCodeRaw: '7159',
        labCaseRef: 'IN-MDL2001',
      },
      {
        id: 'l2'.padEnd(25, '0'),
        groupIndex: 0,
        lineIndex: 1,
        description: 'Filling',
        amount: 200,
        isZero: false,
        status: 'UNMATCHED',
        patientCode: 'TW007159',
        patientCodeRaw: '7159',
        labCaseRef: null,
      },
    ],
    ...over,
  }
}

const fakeRef: { current: any } = { current: null }
function makeFake(state: State) {
  return (fakeRef.current = {
    user: {
      findUnique: async ({ where }: any) =>
        where.id === OWNER
          ? { id: OWNER, name: 'Boss', role: 'OWNER', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [], permissionsJson: null }
          : where.id === EMPLOYEE
            ? { id: EMPLOYEE, name: 'Emp', role: 'EMPLOYEE', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [], permissionsJson: null }
            : null,
    },
    labDocument: {
      update: async ({ data }: any) => Object.assign(state.doc, data),
      updateMany: async () => ({ count: 1 }),
      findUnique: async ({ where, include }: any) => {
        if (!state.doc || where.id !== state.doc.id) return null
        let lines: any[] = [...state.doc.lines]
        // 模擬 Prisma include.lines.where.groupIndex（route 真 DB 用呢個 filter）
        const gi = include?.lines?.where?.groupIndex
        if (gi !== undefined) lines = lines.filter((l: any) => l.groupIndex === gi)
        return { ...state.doc, lines }
      },
    },
    clinic: {
      findUnique: async ({ where }: any) => state.clinics.find((c) => c.id === where.id) ?? null,
    },
    provider: {
      findUnique: async ({ where }: any) => state.providers.find((p) => p.id === where.id) ?? null,
    },
    patientIndex: {
      findFirst: async () => (state.patientName != null ? { patientName: state.patientName } : null),
    },
    costCase: {
      create: async ({ data }: any) => {
        const row = { ...data, id: `cc${state.created.length + 1}`.padEnd(25, '0') }
        state.created.push(data)
        return row
      },
    },
    auditLog: {
      create: async (a: any) => state.audits.push(a.data),
    },
    labDocumentLine: {
      updateMany: async ({ where, data }: any) => {
        const l = state.doc?.lines.find((x: any) => x.id === where.id)
        if (!l || l.status !== 'UNMATCHED') return { count: 0 }
        Object.assign(l, data)
        return { count: 1 }
      },
      findMany: async ({ where }: any) => (state.doc && where.documentId === state.doc.id ? state.doc.lines.map((l: any) => ({ status: l.status })) : []),
    },
    $transaction: async (fn: any) => fn(fakeRef.current),
    labDocWriteLog: {
      findUnique: async ({ where }: any) => state.writeLog.get(where.idempotencyKey) ?? null,
      create: async ({ data }: any) => {
        const row: WriteLogRow = { ...data, responseJson: null }
        state.writeLog.set(data.idempotencyKey, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const row = state.writeLog.get(where.idempotencyKey)
        if (!row) throw new Error('no write log')
        Object.assign(row, data)
        return row
      },      deleteMany: async ({ where }: any) => {
        const row = state.writeLog.get(where.idempotencyKey)
        if (row && row.status === where.status) state.writeLog.delete(where.idempotencyKey)
        return { count: row ? 1 : 0 }
      },
    },
  })
}

const KEYS = ['user', 'labDocument', 'clinic', 'provider', 'patientIndex', 'costCase', 'auditLog', 'labDocWriteLog', 'labDocumentLine', '$transaction'] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]
after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

let POST: any
before(async () => {
  const mod = await import('../../app/api/lab-docs/[id]/new-case/route')
  POST = mod.POST
})

function reset(state: State) {
  const fake = makeFake(state)
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
}

function baseState(over: Partial<State> = {}): State {
  return {
    doc: mkDoc(),
    clinics: [{ id: CLINIC_1, name: '大圍', shortName: 'TW' }],
    providers: [
      { id: PROV_1, name: 'Dr. Chan' },
      { id: PROV_2, name: 'Dr. Ho' },
    ],
    patientName: 'CHAN, TOM',
    created: [],
    audits: [],
    writeLog: new Map(),
    ...over,
  }
}

const BODY_OK = {
  idempotencyKey: 'new-case-001',
  patientCodeNorm: 'TW007159',
  groupIndex: 0,
  itemType: 'Crown',
}

test('§7.6 201 成功：預填全對＋audit 無 patientName', async () => {
  const state = baseState()
  reset(state)
  const r = await POST(makeReq('http://x/api/lab-docs/' + DOC_ID + '/new-case', tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 201)
  const body = await r.json()
  assert.strictEqual(body.case.baseCost, 500) // 300+200 分組合計
  assert.strictEqual(body.case.finalCost, 500)
  assert.strictEqual(body.case.status, 'PRICED')
  assert.strictEqual(body.case.source, 'MANUAL')
  assert.strictEqual(body.case.category, 'LAB')
  assert.strictEqual(body.case.labInvoiceLinked, true)
  assert.strictEqual(body.case.patientCodeNorm, 'TW007159')
  assert.strictEqual(body.case.labOrderNo, 'IN-MDL2001')
  assert.strictEqual(body.case.orderedAt, '2026-09-01') // orderReceivedDate
  assert.strictEqual(body.case.providerId, PROV_1)
  assert.strictEqual(body.case.clinicId, CLINIC_1)
  assert.ok(!('patientName' in body.case), '回應唔回傳 patientName')

  // create data
  assert.strictEqual(state.created.length, 1)
  const data = state.created[0]
  assert.strictEqual(data.patientName, 'CHAN, TOM') // 系統姓名入 DB
  assert.strictEqual(data.baseCost, 500)
  assert.strictEqual(data.finalCost, 500)
  assert.strictEqual(data.discountPct, null) // B4

  // audit
  const audit = state.audits.find((a) => a.action === 'LAB_DOC_CASE_CREATE')
  assert.ok(audit, '有 LAB_DOC_CASE_CREATE audit')
  const afterJson = JSON.parse(audit.afterJson)
  assert.ok(!('patientName' in afterJson), 'audit afterJson 唔記 patientName')
  assert.strictEqual(afterJson.baseCost, 500)
  assert.strictEqual(afterJson.docId, DOC_ID)

  // write log DONE
  const wl = state.writeLog.get('new-case-001')!
  assert.strictEqual(wl.status, 'DONE')
})

test('§7.8 原子：新成本同時連埋分組行；換 key 再撳 → 409（唔會開第二筆）', async () => {
  const state = baseState()
  reset(state)
  const url = 'http://x/api/lab-docs/' + DOC_ID + '/new-case'
  const r = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r.status, 201)
  const body = await r.json()
  assert.strictEqual(body.linkedLineIds.length, 2)
  assert.ok(state.doc.lines.every((l: any) => l.status === 'MATCHED' && l.linkType === 'MAIN'))
  const r2 = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), { ...BODY_OK, idempotencyKey: 'new-case-002' }) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r2.status, 409)
  assert.strictEqual(state.created.length, 1)
  assert.ok(!state.writeLog.has('new-case-002'), '驗證失敗會釋放 key')
})

test('T4 冪等：同 key 同 hash 重放 → 200 replayed（create 只係 1 次）', async () => {
  const state = baseState()
  reset(state)
  const url = 'http://x/api/lab-docs/' + DOC_ID + '/new-case'
  const r1 = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r1.status, 201)
  const b1 = await r1.json()
  const r2 = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(r2.status, 200)
  const b2 = await r2.json()
  assert.strictEqual(b2.replayed, true)
  assert.strictEqual(b2.case.id, b1.case.id)
  assert.strictEqual(state.created.length, 1)
})

test('T4 衝突：同 key 唔同 hash → 409；IN_PROGRESS 同 hash → 409', async () => {
  {
    const state = baseState()
    reset(state)
    const url = 'http://x/api/lab-docs/' + DOC_ID + '/new-case'
    const r1 = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: DOC_ID } } as any)
    assert.strictEqual(r1.status, 201)
    const r2 = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), { ...BODY_OK, itemType: 'Inlay' }) as any, { params: { id: DOC_ID } } as any)
    assert.strictEqual(r2.status, 409)
  }
  {
    const state = baseState()
    state.writeLog.set('new-case-001', {
      idempotencyKey: 'new-case-001',
      requestHash: 'whatever',
      route: 'POST /api/lab-docs/:id/new-case',
      status: 'IN_PROGRESS',
      responseJson: null,
      createdBy: OWNER,
    })
    reset(state)
    // 需要 hash 配到 IN_PROGRESS row（stableRequestHash 同 route 用同一 function）
    const { stableRequestHash } = await import('./write-log')
    const h = stableRequestHash({
      patientCodeNorm: 'TW007159',
      groupIndex: 0,
      itemType: 'Crown',
      orderedAt: null,
      providerId: null,
      docId: DOC_ID,
    })
    state.writeLog.get('new-case-001')!.requestHash = h
    const r = await POST(makeReq('http://x/api/lab-docs/' + DOC_ID + '/new-case', tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: DOC_ID } } as any)
    assert.strictEqual(r.status, 409)
    const body = await r.json()
    assert.match(body.error, /正在處理|新 key/)
  }
})

test('§7.6 400 家族', async () => {
  const url = 'http://x/api/lab-docs/' + DOC_ID + '/new-case'
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...BODY_OK, idempotencyKey: 'bad key!!' }, /idempotencyKey/],
    [{ ...BODY_OK, patientCodeNorm: '7159' }, /patientCodeNorm/], // 純數字無前綴
    [{ ...BODY_OK, itemType: '' }, /itemType/],
    [{ ...BODY_OK, groupIndex: -1 }, /groupIndex/],
    [{ ...BODY_OK, patientCodeNorm: 'TKW000001' }, /唔符/], // 分組 code 唔符
  ]
  for (const [body, re] of cases) {
    const state = baseState()
    reset(state)
    const r = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), body) as any, { params: { id: DOC_ID } } as any)
    assert.strictEqual(r.status, 400, JSON.stringify(body))
    const out = await r.json()
    assert.match(out.error, re, out.error)
    assert.strictEqual(state.created.length, 0)
  }

  // 單據未確認
  {
    const state = baseState({ doc: mkDoc({ status: 'NEEDS_REVIEW' }) })
    reset(state)
    const r = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: DOC_ID } } as any)
    assert.strictEqual(r.status, 400)
  }
  // 未確認診所
  {
    const state = baseState({ doc: mkDoc({ clinicId: null }) })
    reset(state)
    const r = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: DOC_ID } } as any)
    assert.strictEqual(r.status, 400)
  }
  // 分組冇行
  {
    const state = baseState({ doc: mkDoc({ groupIndex: 99 }) })
    reset(state)
    const r = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), { ...BODY_OK, groupIndex: 99 }) as any, { params: { id: DOC_ID } } as any)
    assert.strictEqual(r.status, 400)
  }
  // 冇醫生（doc.providerId null + 無 override）
  {
    const state = baseState({ doc: mkDoc({ providerId: null }) })
    reset(state)
    const r = await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: DOC_ID } } as any)
    assert.strictEqual(r.status, 400)
  }
})

test('§7.6 providerOverride + orderedAt override', async () => {
  const state = baseState({ doc: mkDoc({ orderReceivedDate: null }) })
  reset(state)
  const r = await POST(
    makeReq('http://x/api/lab-docs/' + DOC_ID + '/new-case', tokenFor(OWNER, 'OWNER'), {
      ...BODY_OK,
      providerId: PROV_2,
      orderedAt: '2026-08-20',
    }) as any,
    { params: { id: DOC_ID } } as any,
  )
  assert.strictEqual(r.status, 201)
  const body = await r.json()
  assert.strictEqual(body.case.providerId, PROV_2)
  assert.strictEqual(body.case.orderedAt, '2026-08-20')
})

test('auth：401 無 token；403 EMPLOYEE；404 冇單據；400 壞 doc id', async () => {
  const state = baseState()
  reset(state)
  const url = 'http://x/api/lab-docs/' + DOC_ID + '/new-case'

  assert.strictEqual((await POST(makeReq(url, null, BODY_OK) as any, { params: { id: DOC_ID } } as any)).status, 401)

  const e = await POST(makeReq(url, tokenFor(EMPLOYEE, 'EMPLOYEE'), BODY_OK) as any, { params: { id: DOC_ID } } as any)
  assert.strictEqual(e.status, 403)

  // 404：fake doc id 唔同
  reset(baseState({ doc: mkDoc({ id: 'z'.repeat(25) }) }))
  assert.strictEqual((await POST(makeReq(url, tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: DOC_ID } } as any)).status, 404)

  // 400：壞 doc id
  reset(state)
  assert.strictEqual((await POST(makeReq('http://x/api/lab-docs/bad-id/new-case', tokenFor(OWNER, 'OWNER'), BODY_OK) as any, { params: { id: 'bad-id' } } as any)).status, 400)
})
