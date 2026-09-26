/**
 * X-Staff-Id 必填（cwi-final S5-14 — F5）— patients 臨床 lane 三條 route
 *   - GET  /patients/{cpId}/visits/{visitId}/note
 *   - GET  /patients/{cpId}/visits
 *   - POST /patients/{cpId}/refresh
 *
 * 覆蓋（T826）：
 *   - 冇 X-Staff-Id（或空白）→ 400 STAFF_ID_REQUIRED（唔再 anonymous）
 *   - 有 X-Staff-Id → 照舊過關（note 200 / visits 200 / refresh 進 pipeline — 404 NOT_FOUND 唔係 400）
 *   - audit notes 內 staffId = 傳入值（唔係 anonymous）
 *
 * 全 mock（fake prisma monkey-patch + __setTestCallFn），零 DB。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from '../../../../../lib/prisma'
import { resetExternalRateBuckets } from '../../../../../lib/external-api'
import { resetRxCodeCache } from '../../../../../lib/clinical/extract-rx-codes'
import { __setTestCallFn } from '../../../internal/clinical-index/test-call-fn'
import { GET as noteGET } from './[patientApricotId]/visits/[visitId]/note/route'
import { GET as visitsGET } from './[patientApricotId]/visits/route'
import { POST as refreshPOST } from './[patientApricotId]/refresh/route'

type Any = any

// ── 測試假 key ─────────────────────────────────────────────────────
const KEY_MAIN = 'ext-test-key-main-0000000000000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const KEY_ROWS = [
  { id: 'k-main', name: 'contract-key-main', keyHash: sha(KEY_MAIN), scopes: ['patients'], active: true, lastUsedAt: null },
]

// ── fake 數據 ──────────────────────────────────────────────────────
const VISIT_DATE = new Date('2026-09-20T02:00:00Z')
const NOTE_JSON = { kind: 'STANDARD', complaints: '牙痛', findings: '21 齲壞', diagnosis: '21 齲齒', actions: '充填' }
const auditCreates: Any[] = []

const fakes = {
  externalApiKey: { findMany: async () => KEY_ROWS, update: async () => ({}) },
  externalApiAudit: { create: async (args: Any) => { auditCreates.push(args.data); return {} } },
  auditLog: { create: async (args: Any) => { auditCreates.push(args.data); return {} } },
  clinicalRecordIndex: {
    findUnique: async ({ where }: Any) =>
      where.id === 'visit-1'
        ? { id: 'visit-1', patientApricotId: 'cp-1', clinicId: 'cl-1', visitDate: VISIT_DATE, hasNote: true, noteJson: NOTE_JSON, noteKind: 'STANDARD' }
        : null,
    findMany: async ({ where }: Any) =>
      where.patientApricotId === 'cp-1'
        ? [{
            id: 'visit-1',
            patientApricotId: 'cp-1',
            patientCode: 'TKW001991',
            clinicId: 'cl-1',
            visitDate: VISIT_DATE,
            bookingStatus: 0,
            visitReasonCodes: ['0017'],
            providerCode: null,
            hasNote: false,
            noteKind: null,
            rxCodes: [] as string[],
          }]
        : [],
    findFirst: async () => null, // refresh：無索引行 → 走 NOT_FOUND 路徑（只為證明 staff 關已过）
  },
  clinic: { findMany: async () => [] },
  clinicalRxCode: { findMany: async () => [] },
}

let saved: [Any, string, Any][] = []
before(() => {
  for (const obj of [prisma, basePrisma]) {
    for (const k of Object.keys(fakes) as (keyof typeof fakes)[]) {
      saved.push([obj, k, (obj as Any)[k]])
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
  }
})
after(() => {
  __setTestCallFn(null)
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
})
beforeEach(() => {
  auditCreates.length = 0
  resetExternalRateBuckets()
  resetRxCodeCache()
})

function mkReq(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { 'x-api-key': KEY_MAIN, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const NOTE_PARAMS = { patientApricotId: 'cp-1', visitId: 'visit-1' }
const CP_PARAMS = { patientApricotId: 'cp-1' }

// ── T826：X-Staff-Id 必填 ───────────────────────────────────────────
describe('T826 S5-14：X-Staff-Id 必填（唔再 anonymous）', () => {
  it('note：冇 header → 400 STAFF_ID_REQUIRED', async () => {
    const res = await noteGET(mkReq('GET', '/api/external/v1/patients/cp-1/visits/visit-1/note'), { params: Promise.resolve(NOTE_PARAMS) })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.code, 'STAFF_ID_REQUIRED')
  })

  it('note：空白 header → 400（同缺）', async () => {
    const res = await noteGET(mkReq('GET', '/api/external/v1/patients/cp-1/visits/visit-1/note', { 'x-staff-id': '   ' }), { params: Promise.resolve(NOTE_PARAMS) })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, 'STAFF_ID_REQUIRED')
  })

  it('note：有 header → 200 出全文 + audit staffId = 傳入值（零 anonymous）', async () => {
    const res = await noteGET(mkReq('GET', '/api/external/v1/patients/cp-1/visits/visit-1/note', { 'x-staff-id': 'staff-77' }), { params: Promise.resolve(NOTE_PARAMS) })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.note.complaints, '牙痛')
    const audit = auditCreates.find((a) => a.action === 'EXTERNAL_NOTE_VIEWED')
    assert.ok(audit, '100% audit 照寫')
    const notes = JSON.parse(audit.notes)
    assert.equal(notes.staffId, 'staff-77')
    assert.notEqual(notes.staffId, 'anonymous')
  })

  it('visits：冇 header → 400；有 header → 200（staffId 入 audit）', async () => {
    const noRes = await visitsGET(mkReq('GET', '/api/external/v1/patients/cp-1/visits'), { params: Promise.resolve(CP_PARAMS) })
    assert.equal(noRes.status, 400)
    assert.equal((await noRes.json()).code, 'STAFF_ID_REQUIRED')

    const res = await visitsGET(mkReq('GET', '/api/external/v1/patients/cp-1/visits', { 'x-staff-id': 'staff-77' }), { params: Promise.resolve(CP_PARAMS) })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.visits.length, 1)
    assert.equal(body.visits[0].visitId, 'visit-1')
  })

  it('refresh：冇 header → 400（staff 關喺 rate bucket 之前 — 零 bucket 消耗）', async () => {
    const res = await refreshPOST(mkReq('POST', '/api/external/v1/patients/cp-1/refresh'), { params: Promise.resolve(CP_PARAMS) })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, 'STAFF_ID_REQUIRED')
  })

  it('refresh：有 header → 過 staff 關進 pipeline（fake callFn 空 appointment → 404 NOT_FOUND，唔係 400）', async () => {
    __setTestCallFn(async () => [] as Any[])
    const res = await refreshPOST(mkReq('POST', '/api/external/v1/patients/cp-1/refresh', { 'x-staff-id': 'staff-77' }), { params: Promise.resolve(CP_PARAMS) })
    assert.equal(res.status, 404)
    assert.equal((await res.json()).code, 'PATIENT_NOT_FOUND')
  })
})
