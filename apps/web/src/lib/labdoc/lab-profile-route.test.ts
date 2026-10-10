/**
 * cwm-labdoc P4 CHUNK 1 — GET/PUT /api/lab-profiles/:labId unit（§12.6 Lab 設定）
 *
 * 覆蓋（工單：逐 field — extractionHint 超限 400、RBAC 403）：
 *  - GET：200 有 row／冇 row（defaults + exists:false）＋ payees 清單；404 Lab 唔存在；400 id 格式
 *  - RBAC：401 無 token；EMPLOYEE 無 grant → 403；EMPLOYEE 只有 lab_invoice → 403（要 lab_statement）
 *  - PUT：200 全欄 update（含 payees 增刪 + audit LAB_PROFILE_UPDATE before/after）
 *  - PUT：partial update（唔傳 = 唔改）
 *  - PUT：create（冇 row + updatedAt=null）
 *  - 400：extractionHint >500／statementKind 枚舉／defaultDocNoKind 枚舉／docNoSame 非 boolean／
 *         updatedAt 缺失或格式錯／payees 非陣列／payee 非 string／payee 空正規化／payee 超 120／清單 >50
 *  - 409：updatedAt 唔等（快照過期）；updateMany 0 row（並發）；冇 row 但帶 updatedAt；
 *         並發 create P2002；PAYEE_ALIAS_CONFLICT（收款人歸另一間 Lab）
 *  - 404：PUT Lab 唔存在
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { NextRequest } from 'next/server'
import { createToken } from '../auth'

const OWNER = 'f'.repeat(25)
const EMP = 'e'.repeat(25) // EMPLOYEE + grant lab_statement
const EMP_INV = 'i'.repeat(25) // EMPLOYEE + grant 只有 lab_invoice
const NOPE = 'n'.repeat(25) // EMPLOYEE 無 grant
const LAB_A = 'l'.repeat(25)
const LAB_B = 'q'.repeat(25)
const USER_A = 'u'.repeat(25)
const T0 = new Date('2026-10-06T10:00:00.000Z')
const T1 = new Date('2026-10-06T11:00:00.000Z')

interface State {
  labs: Map<string, { id: string; name: string }>
  profiles: Map<string, any>
  aliases: Array<{ id: string; labId: string; kind: string; rawNorm: string; createdAt: Date }>
  audits: any[]
  aliasSeq: number
  forceUpdateManyZero?: boolean
  forceCreateP2002?: boolean
}

const state: State = {
  labs: new Map(),
  profiles: new Map(),
  aliases: [],
  audits: [],
  aliasSeq: 0,
}

function makeFakePrisma() {
  const labProfile = {
    findUnique: async ({ where }: any) => state.profiles.get(where.labId) ?? null,
    findUniqueOrThrow: async ({ where }: any) => {
      const r = state.profiles.get(where.labId)
      if (!r) throw new Error('P2025')
      return r
    },
    create: async ({ data }: any) => {
      if (state.forceCreateP2002) {
        const e: any = new Error('Unique constraint')
        e.code = 'P2002'
        throw e
      }
      if (state.profiles.has(data.labId)) {
        const e: any = new Error('Unique constraint')
        e.code = 'P2002'
        throw e
      }
      const row = { ...data, updatedAt: new Date(T1.getTime()) }
      state.profiles.set(data.labId, row)
      return row
    },
    updateMany: async ({ where, data }: any) => {
      if (state.forceUpdateManyZero) return { count: 0 }
      const row = state.profiles.get(where.labId)
      if (!row) return { count: 0 }
      if (where.updatedAt && row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 }
      const next = { ...row, ...data, updatedAt: new Date(T1.getTime()) }
      state.profiles.set(where.labId, next)
      return { count: 1 }
    },
  }
  const labAlias = {
    findMany: async ({ where }: any) =>
      state.aliases
        .filter((a) => (where.labId ? a.labId === where.labId : true) && (where.kind ? a.kind === where.kind : true))
        .map((a) => ({ rawNorm: a.rawNorm, id: a.id })),
    findFirst: async ({ where }: any) => {
      const normMatch = (a: any) =>
        typeof where.rawNorm === 'string'
          ? a.rawNorm === where.rawNorm
          : where.rawNorm?.in?.includes(a.rawNorm)
      return state.aliases.find((a) => (where.kind ? a.kind === where.kind : true) && normMatch(a)) ?? null
    },
    deleteMany: async ({ where }: any) => {
      const before = state.aliases.length
      state.aliases = state.aliases.filter(
        (a) =>
          !((where.labId ? a.labId === where.labId : true) &&
            a.kind === where.kind &&
            (typeof where.rawNorm === 'string'
              ? a.rawNorm === where.rawNorm
              : where.rawNorm?.in?.includes(a.rawNorm))),
      )
      return { count: before - state.aliases.length }
    },
    create: async ({ data }: any) => {
      state.aliasSeq++
      const row = { id: `al-${state.aliasSeq}`, ...data, createdAt: new Date() }
      state.aliases.push(row)
      return row
    },
  }
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
    lab: {
      findUnique: async ({ where }: any) => state.labs.get(where.id) ?? null,
    },
    labProfile,
    labAlias,
    auditLog: { create: async (a: any) => state.audits.push(a.data) },
    $transaction: async (fn: any) => {
      // 真 Prisma tx：throw = 回滾 — fake 快照/還原模擬
      const snap = {
        profiles: new Map([...state.profiles].map(([k, v]) => [k, { ...v }])),
        aliases: state.aliases.map((a) => ({ ...a })),
        audits: [...state.audits],
        aliasSeq: state.aliasSeq,
      }
      try {
        return await fn(makeFakePrisma())
      } catch (e) {
        state.profiles = snap.profiles
        state.aliases = snap.aliases
        state.audits = snap.audits
        state.aliasSeq = snap.aliasSeq
        throw e
      }
    },
  }
}

let GET: any
let PUT: any
import { prisma } from '../prisma'

const KEYS = ['user', 'lab', 'labProfile', 'labAlias', 'auditLog', '$transaction'] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]

function installFake() {
  const fake = makeFakePrisma()
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
}

function reset(over: { profile?: any; payees?: Array<[string, string]>; labB?: boolean } = {}) {
  state.labs = new Map()
  state.labs.set(LAB_A, { id: LAB_A, name: 'Sodental' })
  if (over.labB) state.labs.set(LAB_B, { id: LAB_B, name: 'Aegis' })
  state.profiles = new Map()
  if (over.profile) state.profiles.set(LAB_A, { ...over.profile })
  state.aliases = (over.payees ?? []).map(([labId, rawNorm]) => ({
    id: `seed-${labId}-${rawNorm}`,
    labId,
    kind: 'PAYEE',
    rawNorm,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }))
  state.audits = []
  state.forceUpdateManyZero = undefined
  state.forceCreateP2002 = undefined
  installFake()
}

function tok(userId: string, role: 'OWNER' | 'EMPLOYEE' = 'EMPLOYEE') {
  return createToken({ userId, role, clinics: [], tokenVersion: 0 })
}

function makeReq(url: string, token: string | null, method: 'GET' | 'PUT', body?: unknown): NextRequest {
  const headers: Record<string, string> = token ? { cookie: `session=${token}` } : {}
  if (method === 'PUT') headers['content-type'] = 'application/json'
  return new NextRequest(url, {
    method,
    headers,
    body: method === 'PUT' ? JSON.stringify(body ?? {}) : undefined,
  })
}

const params = (labId: string) => ({ params: { labId } })

before(async () => {
  const mod = await import('../../app/api/lab-profiles/[labId]/route')
  GET = mod.GET
  PUT = mod.PUT
})

after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

// ── GET ─────────────────────────────────────────────────────────────────

test('GET：有 row → 200 全欄＋payees', async () => {
  reset({
    profile: {
      labId: LAB_A,
      statementKind: 'DETAIL',
      statementDocNoSameAsInvoice: false,
      defaultDocNoKind: 'CASE_NO',
      extractionHint: '名後 4 位係病人編號',
      updatedBy: USER_A,
      updatedAt: T0,
    },
    payees: [[LAB_A, 'honestygifts']],
  })
  const r = await GET(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'GET'), params(LAB_A))
  assert.strictEqual(r.status, 200)
  const d = await r.json()
  assert.strictEqual(d.exists, true)
  assert.strictEqual(d.statementKind, 'DETAIL')
  assert.strictEqual(d.statementDocNoSameAsInvoice, false)
  assert.strictEqual(d.defaultDocNoKind, 'CASE_NO')
  assert.strictEqual(d.extractionHint, '名後 4 位係病人編號')
  assert.strictEqual(d.updatedAt, T0.toISOString())
  assert.deepStrictEqual(d.payees, ['honestygifts'])
})

test('GET：冇 row → 200 defaults + exists:false + updatedAt null', async () => {
  reset()
  const r = await GET(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'GET'), params(LAB_A))
  assert.strictEqual(r.status, 200)
  const d = await r.json()
  assert.strictEqual(d.exists, false)
  assert.strictEqual(d.statementKind, 'INVOICE_LIST')
  assert.strictEqual(d.statementDocNoSameAsInvoice, true)
  assert.strictEqual(d.defaultDocNoKind, 'INVOICE_NO')
  assert.strictEqual(d.extractionHint, null)
  assert.strictEqual(d.updatedAt, null)
  assert.deepStrictEqual(d.payees, [])
})

test('GET：404 Lab 唔存在；400 id 格式錯', async () => {
  reset()
  assert.strictEqual((await GET(makeReq(`http://x/api/lab-profiles/${'z'.repeat(25)}`, tok(OWNER, 'OWNER'), 'GET'), params('z'.repeat(25)))).status, 404)
  assert.strictEqual((await GET(makeReq('http://x/api/lab-profiles/bad-id', tok(OWNER, 'OWNER'), 'GET'), params('bad-id'))).status, 400)
})

// ── RBAC ───────────────────────────────────────────────────────────────

test('RBAC：401 無 token；EMPLOYEE 無 grant 403；只有 lab_invoice 403', async () => {
  reset()
  assert.strictEqual((await GET(makeReq(`http://x/api/lab-profiles/${LAB_A}`, null, 'GET'), params(LAB_A))).status, 401)
  // EMPLOYEE 無 lab grant → matrix role miss + 無 lab_statement override → 403
  assert.strictEqual((await GET(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(NOPE), 'GET'), params(LAB_A))).status, 403)
  // 只有 lab_invoice（冇 lab_statement）→ 403（P4 route 全部 lab_statement）
  assert.strictEqual((await GET(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(EMP_INV), 'GET'), params(LAB_A))).status, 403)
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(EMP_INV), 'PUT', { updatedAt: null }), params(LAB_A))).status, 403)
})

test('RBAC：有 lab_statement grant 嘅 EMPLOYEE 放行', async () => {
  reset()
  assert.strictEqual((await GET(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(EMP), 'GET'), params(LAB_A))).status, 200)
})

// ── PUT happy ──────────────────────────────────────────────────────────

test('PUT：全欄 update（含 payees 增刪）＋ audit before/after', async () => {
  reset({
    profile: {
      labId: LAB_A,
      statementKind: 'INVOICE_LIST',
      statementDocNoSameAsInvoice: true,
      defaultDocNoKind: 'INVOICE_NO',
      extractionHint: null,
      updatedBy: USER_A,
      updatedAt: T0,
    },
    payees: [[LAB_A, 'honestygifts']],
  })
  const body = {
    updatedAt: T0.toISOString(),
    statementKind: 'OUTSTANDING',
    statementDocNoSameAsInvoice: false,
    defaultDocNoKind: 'CASE_NO',
    extractionHint: '最後 7 位係 Lab 編號',
    payees: ['Honesty Gifts', 'aegis dental ltd'], // norm → honestygifts（保留）＋ aegis（新增 — dental/ltd 係 suffix 會去）
  }
  const r = await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', body), params(LAB_A))
  assert.strictEqual(r.status, 200)
  const d = await r.json()
  assert.strictEqual(d.statementKind, 'OUTSTANDING')
  assert.strictEqual(d.statementDocNoSameAsInvoice, false)
  assert.strictEqual(d.defaultDocNoKind, 'CASE_NO')
  assert.strictEqual(d.extractionHint, '最後 7 位係 Lab 編號')
  assert.deepStrictEqual([...d.payees].sort(), ['aegis', 'honestygifts'])
  // alias 實錄
  assert.deepStrictEqual(state.aliases.map((a) => a.rawNorm).sort(), ['aegis', 'honestygifts'])
  // audit
  assert.strictEqual(state.audits.length, 1)
  const a = state.audits[0]
  assert.strictEqual(a.action, 'LAB_PROFILE_UPDATE')
  assert.strictEqual(a.entity, 'LabProfile')
  assert.strictEqual(a.entityId, LAB_A)
  assert.strictEqual(a.actorId, OWNER)
  assert.strictEqual(a.beforeJson && JSON.parse(a.beforeJson).statementKind, 'INVOICE_LIST')
  assert.deepStrictEqual(JSON.parse(a.beforeJson).payees, ['honestygifts'])
  assert.strictEqual(JSON.parse(a.afterJson).statementKind, 'OUTSTANDING')
  assert.strictEqual(JSON.parse(a.afterJson).extractionHint, '最後 7 位係 Lab 編號')
})

test('PUT：partial update（只傳 extractionHint）— 其餘欄唔改', async () => {
  reset({
    profile: {
      labId: LAB_A,
      statementKind: 'DETAIL',
      statementDocNoSameAsInvoice: false,
      defaultDocNoKind: 'CASE_NO',
      extractionHint: null,
      updatedBy: USER_A,
      updatedAt: T0,
    },
  })
  const r = await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: T0.toISOString(), extractionHint: '新提示' }), params(LAB_A))
  assert.strictEqual(r.status, 200)
  const d = await r.json()
  assert.strictEqual(d.statementKind, 'DETAIL')
  assert.strictEqual(d.statementDocNoSameAsInvoice, false)
  assert.strictEqual(d.defaultDocNoKind, 'CASE_NO')
  assert.strictEqual(d.extractionHint, '新提示')
})

test('PUT：create（冇 row + updatedAt=null）— 預設值 + 傳入欄', async () => {
  reset()
  const r = await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: null, extractionHint: 'first hint' }), params(LAB_A))
  assert.strictEqual(r.status, 200)
  const d = await r.json()
  assert.strictEqual(d.exists, true)
  assert.strictEqual(d.statementKind, 'INVOICE_LIST')
  assert.strictEqual(d.defaultDocNoKind, 'INVOICE_NO')
  assert.strictEqual(d.extractionHint, 'first hint')
  const row = state.profiles.get(LAB_A)
  assert.strictEqual(row.updatedBy, OWNER)
})

test('PUT：payees 全量語義 — 冇傳 payees 唔動 alias；傳 [] 清晒', async () => {
  reset({ payees: [[LAB_A, 'honestygifts']] })
  // 唔傳 payees
  const r1 = await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: null, statementKind: 'DETAIL' }), params(LAB_A))
  assert.strictEqual(r1.status, 200)
  assert.strictEqual(state.aliases.length, 1)
  // 傳 []（行已存在，跟返 response 嘅 updatedAt）
  const d1 = await r1.json()
  const r2 = await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: d1.updatedAt, payees: [] }), params(LAB_A))
  assert.strictEqual(r2.status, 200)
  assert.deepStrictEqual((await r2.json()).payees, [])
  assert.strictEqual(state.aliases.length, 0)
})

// ── PUT 驗證 400 ───────────────────────────────────────────────────────

test('PUT：extractionHint 超 500 → 400；恰 500 → 200', async () => {
  reset()
  const over500 = 'a'.repeat(501)
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: null, extractionHint: over500 }), params(LAB_A))).status, 400)
  const exactly500 = 'b'.repeat(500)
  const r = await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: null, extractionHint: exactly500 }), params(LAB_A))
  assert.strictEqual(r.status, 200)
  assert.strictEqual((await r.json()).extractionHint.length, 500)
})

test('PUT：枚舉／類型 400', async () => {
  reset()
  const base = { updatedAt: null }
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { ...base, statementKind: 'MONTHLY' }), params(LAB_A))).status, 400)
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { ...base, defaultDocNoKind: 'OTHER' }), params(LAB_A))).status, 400)
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { ...base, statementDocNoSameAsInvoice: 'yes' as any }), params(LAB_A))).status, 400)
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { ...base, extractionHint: 123 as any }), params(LAB_A))).status, 400)
  // 400 後冇寫入
  assert.strictEqual(state.profiles.size, 0)
  assert.strictEqual(state.audits.length, 0)
})

test('PUT：updatedAt 缺失／格式錯 → 400', async () => {
  reset()
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { statementKind: 'DETAIL' }), params(LAB_A))).status, 400)
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: 'not-a-date' }), params(LAB_A))).status, 400)
})

test('PUT：payees 格式 400', async () => {
  reset()
  const base = { updatedAt: null }
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { ...base, payees: 'honestygifts' as any }), params(LAB_A))).status, 400)
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { ...base, payees: ['ok', 123] }), params(LAB_A))).status, 400)
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { ...base, payees: ['   '] }), params(LAB_A))).status, 200) // 全空白 → 空清單（合法）
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: null, payees: ['x'.repeat(121)] }), params(LAB_A))).status, 400)
  const tooMany = Array.from({ length: 51 }, (_, i) => `payee${i}`)
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { ...base, payees: tooMany }), params(LAB_A))).status, 400)
})

// ── PUT 409 並發 ───────────────────────────────────────────────────────

test('PUT：updatedAt 快照過期 → 409（冇寫入冇 audit）', async () => {
  reset({
    profile: {
      labId: LAB_A,
      statementKind: 'INVOICE_LIST',
      statementDocNoSameAsInvoice: true,
      defaultDocNoKind: 'INVOICE_NO',
      extractionHint: null,
      updatedBy: USER_A,
      updatedAt: T0,
    },
  })
  const stale = new Date('2026-10-06T09:00:00.000Z').toISOString()
  const r = await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: stale, extractionHint: 'x' }), params(LAB_A))
  assert.strictEqual(r.status, 409)
  assert.strictEqual(state.profiles.get(LAB_A).extractionHint, null)
  assert.strictEqual(state.audits.length, 0)
})

test('PUT：updateMany 0 row（並發寫）→ 409', async () => {
  reset({
    profile: {
      labId: LAB_A,
      statementKind: 'INVOICE_LIST',
      statementDocNoSameAsInvoice: true,
      defaultDocNoKind: 'INVOICE_NO',
      extractionHint: null,
      updatedBy: USER_A,
      updatedAt: T0,
    },
  })
  // 模擬：快照匹配，但 updateMany 時行已被另一 request 改（where.updatedAt mismatch）
  state.forceUpdateManyZero = true
  const r = await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: T0.toISOString(), extractionHint: 'x' }), params(LAB_A))
  assert.strictEqual(r.status, 409)
})

test('PUT：冇 row 但帶 updatedAt → 409；並發 create P2002 → 409', async () => {
  reset()
  const r1 = await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: T0.toISOString(), extractionHint: 'x' }), params(LAB_A))
  assert.strictEqual(r1.status, 409)
  // P2002：create 撞 unique（並發 create）
  state.forceCreateP2002 = true
  const r2 = await PUT(makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: null, extractionHint: 'x' }), params(LAB_A))
  assert.strictEqual(r2.status, 409)
  assert.strictEqual(state.audits.length, 0)
})

test('PUT：PAYEE_ALIAS_CONFLICT — 收款人歸另一間 Lab → 409', async () => {
  reset({ labB: true, payees: [[LAB_B, 'honestygifts']] })
  const r = await PUT(
    makeReq(`http://x/api/lab-profiles/${LAB_A}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: null, payees: ['Honesty Gifts'] }),
    params(LAB_A),
  )
  assert.strictEqual(r.status, 409)
  const d = await r.json()
  assert.match(d.error, /PAYEE_ALIAS_CONFLICT/)
  // 冇寫入（tx 回滾口徑：LAB_A 冇 profile，LAB_B 嘅 alias 保留）
  assert.strictEqual(state.profiles.size, 0)
  assert.strictEqual(state.aliases.length, 1)
  assert.strictEqual(state.aliases[0].labId, LAB_B)
})

test('PUT：404 Lab 唔存在', async () => {
  reset()
  assert.strictEqual((await PUT(makeReq(`http://x/api/lab-profiles/${'z'.repeat(25)}`, tok(OWNER, 'OWNER'), 'PUT', { updatedAt: null }), params('z'.repeat(25)))).status, 404)
})
