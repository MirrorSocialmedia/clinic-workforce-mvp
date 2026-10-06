/**
 * cwm-labdoc P4 CHUNK 2 — GET/DELETE /api/lab-aliases unit（§11 alias 管理）
 *
 * 覆蓋（工單：type filter、404、403）：
 *  - GET：200 四表混合統一 row（含 lab/clinic/provider name join）；?type= 單表；?labId= filter
 *  - GET：400 type 非法／labId 格式／labId + ClinicNameAlias
 *  - RBAC：401 無 token；EMPLOYEE 無 grant 403；只有 lab_invoice 403（要 lab_statement）
 *  - DELETE：200 四種 type 各刪（audit LAB_ALIAS_DELETE before 快照）；404 唔存在；
 *            400 type 缺失／非法／id 格式錯
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { NextRequest } from 'next/server'
import { createToken } from '../auth'

const OWNER = 'f'.repeat(25)
const EMP = 'e'.repeat(25) // + grant lab_statement
const EMP_INV = 'i'.repeat(25) // + grant 只有 lab_invoice
const NOPE = 'n'.repeat(25) // 無 grant
const LAB_A = 'l'.repeat(25)
const LAB_B = 'q'.repeat(25)
const CLINIC_A = 'c'.repeat(25)
const PROVIDER_A = 'p'.repeat(25)

interface Row {
  id: string
  labId?: string
  kind?: string
  rawNorm?: string
  customerNo?: string
  clinicId?: string
  providerId?: string | null
  createdBy: string
  createdAt: Date
}

interface State {
  labAliases: Array<Row & { lab?: { id: string; name: string } }>
  custNos: Row[]
  clinicAliases: Row[]
  providerAliases: Row[]
  audits: any[]
}

const state: State = {
  labAliases: [],
  custNos: [],
  clinicAliases: [],
  providerAliases: [],
  audits: [],
}

function seed() {
  state.labAliases = [
    { id: 'la1'.padEnd(25, 'a'), labId: LAB_A, kind: 'NAME_EN', rawNorm: 'sodental', createdBy: OWNER, createdAt: new Date('2026-01-01T00:00:00Z') },
    { id: 'la2'.padEnd(25, 'b'), labId: LAB_A, kind: 'PAYEE', rawNorm: 'honestygifts', createdBy: OWNER, createdAt: new Date('2026-01-02T00:00:00Z') },
    { id: 'la3'.padEnd(25, 'c'), labId: LAB_B, kind: 'NAME_CN', rawNorm: '禾呈', createdBy: OWNER, createdAt: new Date('2026-01-03T00:00:00Z') },
  ]
  state.custNos = [
    { id: 'cn1'.padEnd(25, '1'), labId: LAB_A, customerNo: 'TY007159', clinicId: CLINIC_A, providerId: PROVIDER_A, createdBy: OWNER, createdAt: new Date('2026-01-04T00:00:00Z') },
    { id: 'cn2'.padEnd(25, '2'), labId: LAB_B, customerNo: 'D3-999', clinicId: CLINIC_A, providerId: null, createdBy: OWNER, createdAt: new Date('2026-01-05T00:00:00Z') },
  ]
  state.clinicAliases = [
    { id: 'ca1'.padEnd(25, 'a'), rawNorm: '大圍', clinicId: CLINIC_A, createdBy: OWNER, createdAt: new Date('2026-01-06T00:00:00Z') },
  ]
  state.providerAliases = [
    { id: 'pa1'.padEnd(25, 'a'), rawNorm: 'drchan', providerId: PROVIDER_A, createdBy: OWNER, createdAt: new Date('2026-01-07T00:00:00Z') },
  ]
  state.audits = []
  installFake()
}

function makeFakePrisma() {
  const labName = (id: string) => (id === LAB_A ? 'Sodental' : 'Aegis')
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
    labAlias: {
      findMany: async ({ where }: any) =>
        state.labAliases
          .filter((a) => (where?.labId ? a.labId === where.labId : true))
          .map((a) => ({ ...a, lab: { id: a.labId, name: labName(a.labId!) } })),
      findUnique: async ({ where }: any) => {
        const r = state.labAliases.find((a) => a.id === where.id)
        return r ? { ...r, lab: { id: r.labId, name: labName(r.labId!) } } : null
      },
      delete: async ({ where }: any) => {
        const i = state.labAliases.findIndex((a) => a.id === where.id)
        if (i < 0) throw Object.assign(new Error('RecordNotFound'), { code: 'P2025' })
        state.labAliases.splice(i, 1)
        return { ...where }
      },
    },
    labCustomerNo: {
      findMany: async ({ where }: any) =>
        state.custNos.filter((c) => (where?.labId ? c.labId === where.labId : true)),
      findUnique: async ({ where }: any) => state.custNos.find((c) => c.id === where.id) ?? null,
      delete: async ({ where }: any) => {
        const i = state.custNos.findIndex((c) => c.id === where.id)
        if (i < 0) throw Object.assign(new Error('RecordNotFound'), { code: 'P2025' })
        state.custNos.splice(i, 1)
        return { ...where }
      },
    },
    clinicNameAlias: {
      findMany: async () => [...state.clinicAliases],
      findUnique: async ({ where }: any) => state.clinicAliases.find((a) => a.id === where.id) ?? null,
      delete: async ({ where }: any) => {
        const i = state.clinicAliases.findIndex((a) => a.id === where.id)
        if (i < 0) throw Object.assign(new Error('RecordNotFound'), { code: 'P2025' })
        state.clinicAliases.splice(i, 1)
        return { ...where }
      },
    },
    providerNameAlias: {
      findMany: async () => [...state.providerAliases],
      findUnique: async ({ where }: any) => state.providerAliases.find((a) => a.id === where.id) ?? null,
      delete: async ({ where }: any) => {
        const i = state.providerAliases.findIndex((a) => a.id === where.id)
        if (i < 0) throw Object.assign(new Error('RecordNotFound'), { code: 'P2025' })
        state.providerAliases.splice(i, 1)
        return { ...where }
      },
    },
    clinic: {
      findMany: async ({ where }: any) =>
        [{ id: CLINIC_A, name: '大圍診所' }].filter((c) => (where?.id?.in ? where.id.in.includes(c.id) : true)),
    },
    provider: {
      findMany: async ({ where }: any) =>
        [{ id: PROVIDER_A, name: 'Dr. Chan' }].filter((p) => (where?.id?.in ? where.id.in.includes(p.id) : true)),
    },
    auditLog: { create: async (a: any) => state.audits.push(a.data) },
  }
}

let GET: any
let DEL: any
import { prisma } from '../prisma'

const KEYS = ['user', 'labAlias', 'labCustomerNo', 'clinicNameAlias', 'providerNameAlias', 'clinic', 'provider', 'auditLog'] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]

function installFake() {
  const fake = makeFakePrisma()
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: (fake as any)[k], configurable: true, writable: true })
}

function tok(userId: string, role: 'OWNER' | 'EMPLOYEE' = 'EMPLOYEE') {
  return createToken({ userId, role, clinics: [], tokenVersion: 0 })
}

function makeReq(url: string, token: string | null, method: 'GET' | 'DELETE'): NextRequest {
  return new NextRequest(url, { method, headers: token ? { cookie: `session=${token}` } : {} })
}

before(async () => {
  const g = await import('../../app/api/lab-aliases/route')
  const d = await import('../../app/api/lab-aliases/[id]/route')
  GET = g.GET
  DEL = d.DELETE
})

after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

// ── GET ─────────────────────────────────────────────────────────────────

test('GET：唔傳 type = 四表混合統一 row（name join）', async () => {
  seed()
  const r = await GET(makeReq('http://x/api/lab-aliases', tok(OWNER, 'OWNER'), 'GET'))
  assert.strictEqual(r.status, 200)
  const d = await r.json()
  assert.strictEqual(d.count, 7)
  const types = d.aliases.map((a: any) => a.type).sort()
  assert.deepStrictEqual(types, ['ClinicNameAlias', 'LabAlias', 'LabAlias', 'LabAlias', 'LabCustomerNo', 'LabCustomerNo', 'ProviderNameAlias'])
  const la = d.aliases.find((a: any) => a.id === state.labAliases[0]?.id)
  assert.strictEqual(la.labName, 'Sodental')
  assert.strictEqual(la.kind, 'NAME_EN')
  assert.strictEqual(la.rawNorm, 'sodental')
  const cn = d.aliases.find((a: any) => a.id === state.custNos[0]?.id)
  assert.strictEqual(cn.customerNo, 'TY007159')
  assert.strictEqual(cn.clinicName, '大圍診所')
  const ca = d.aliases.find((a: any) => a.type === 'ClinicNameAlias')
  assert.strictEqual(ca.clinicName, '大圍診所')
  const pa = d.aliases.find((a: any) => a.type === 'ProviderNameAlias')
  assert.strictEqual(pa.providerName, 'Dr. Chan')
})

test('GET：?type=LabAlias 只回 LabAlias；?type=LabCustomerNo&labId= 過濾', async () => {
  seed()
  const r1 = await GET(makeReq('http://x/api/lab-aliases?type=LabAlias', tok(OWNER, 'OWNER'), 'GET'))
  assert.strictEqual(r1.status, 200)
  const d1 = await r1.json()
  assert.strictEqual(d1.count, 3)
  assert.ok(d1.aliases.every((a: any) => a.type === 'LabAlias'))

  const r2 = await GET(makeReq(`http://x/api/lab-aliases?type=LabCustomerNo&labId=${LAB_A}`, tok(OWNER, 'OWNER'), 'GET'))
  assert.strictEqual(r2.status, 200)
  const d2 = await r2.json()
  assert.strictEqual(d2.count, 1)
  assert.strictEqual(d2.aliases[0].customerNo, 'TY007159')
})

test('GET：400 type 非法；labId 格式錯；labId + ClinicNameAlias', async () => {
  seed()
  assert.strictEqual((await GET(makeReq('http://x/api/lab-aliases?type=BOGUS', tok(OWNER, 'OWNER'), 'GET'))).status, 400)
  assert.strictEqual((await GET(makeReq('http://x/api/lab-aliases?type=LabAlias&labId=bad-id', tok(OWNER, 'OWNER'), 'GET'))).status, 400)
  assert.strictEqual((await GET(makeReq(`http://x/api/lab-aliases?type=ClinicNameAlias&labId=${LAB_A}`, tok(OWNER, 'OWNER'), 'GET'))).status, 400)
})

test('GET RBAC：401 無 token；無 grant 403；只有 lab_invoice 403', async () => {
  seed()
  assert.strictEqual((await GET(makeReq('http://x/api/lab-aliases', null, 'GET'))).status, 401)
  assert.strictEqual((await GET(makeReq('http://x/api/lab-aliases', tok(NOPE), 'GET'))).status, 403)
  assert.strictEqual((await GET(makeReq('http://x/api/lab-aliases', tok(EMP_INV), 'GET'))).status, 403)
})

// ── DELETE ──────────────────────────────────────────────────────────────

test('DELETE：四種 type 各刪 + audit LAB_ALIAS_DELETE before 快照', async () => {
  seed()
  const cases: Array<[string, string]> = [
    ['LabAlias', state.labAliases[0].id],
    ['LabCustomerNo', state.custNos[0].id],
    ['ClinicNameAlias', state.clinicAliases[0].id],
    ['ProviderNameAlias', state.providerAliases[0].id],
  ]
  for (const [type, id] of cases) {
    const r = await DEL(makeReq(`http://x/api/lab-aliases/${id}?type=${type}`, tok(OWNER, 'OWNER'), 'DELETE'), { params: { id } })
    assert.strictEqual(r.status, 200, `type=${type}`)
    const d = await r.json()
    assert.strictEqual(d.ok, true)
    assert.strictEqual(d.type, type)
  }
  assert.strictEqual(state.labAliases.length, 2)
  assert.strictEqual(state.custNos.length, 1)
  assert.strictEqual(state.clinicAliases.length, 0)
  assert.strictEqual(state.providerAliases.length, 0)
  // audit
  assert.strictEqual(state.audits.length, 4)
  assert.ok(state.audits.every((a) => a.action === 'LAB_ALIAS_DELETE'))
  assert.strictEqual(state.audits[0].entity, 'LabAlias')
  assert.strictEqual(JSON.parse(state.audits[0].beforeJson).labName, 'Sodental')
  assert.strictEqual(JSON.parse(state.audits[1].beforeJson).customerNo, 'TY007159')
  assert.strictEqual(state.audits[2].entity, 'ClinicNameAlias')
  assert.strictEqual(state.audits[3].entity, 'ProviderNameAlias')
  assert.strictEqual(state.audits[0].actorId, OWNER)
})

test('DELETE：404 唔存在（type 對但 id 冇）', async () => {
  seed()
  const r = await DEL(makeReq(`http://x/api/lab-aliases/${'z'.repeat(25)}?type=LabAlias`, tok(OWNER, 'OWNER'), 'DELETE'), { params: { id: 'z'.repeat(25) } })
  assert.strictEqual(r.status, 404)
  assert.strictEqual(state.audits.length, 0)
  // id 存在但係另一張表（LabCustomerNo 嘅 id 當 LabAlias 刪）→ 404
  const r2 = await DEL(makeReq(`http://x/api/lab-aliases/${state.custNos[0].id}?type=LabAlias`, tok(OWNER, 'OWNER'), 'DELETE'), { params: { id: state.custNos[0].id } })
  assert.strictEqual(r2.status, 404)
})

test('DELETE：400 type 缺失／非法；id 格式錯', async () => {
  seed()
  const id = state.labAliases[0].id
  assert.strictEqual((await DEL(makeReq(`http://x/api/lab-aliases/${id}`, tok(OWNER, 'OWNER'), 'DELETE'), { params: { id } })).status, 400)
  assert.strictEqual((await DEL(makeReq(`http://x/api/lab-aliases/${id}?type=BOGUS`, tok(OWNER, 'OWNER'), 'DELETE'), { params: { id } })).status, 400)
  assert.strictEqual((await DEL(makeReq('http://x/api/lab-aliases/bad-id?type=LabAlias', tok(OWNER, 'OWNER'), 'DELETE'), { params: { id: 'bad-id' } })).status, 400)
})

test('DELETE RBAC：只有 lab_invoice → 403；無 grant → 403', async () => {
  seed()
  const id = state.labAliases[0].id
  assert.strictEqual((await DEL(makeReq(`http://x/api/lab-aliases/${id}?type=LabAlias`, tok(EMP_INV), 'DELETE'), { params: { id } })).status, 403)
  assert.strictEqual((await DEL(makeReq(`http://x/api/lab-aliases/${id}?type=LabAlias`, tok(NOPE), 'DELETE'), { params: { id } })).status, 403)
})
