/**
 * External duty-roster v1 遷移 tests（MD §A.4 / §C.2）— cw-extapi-20260823-a1
 *
 * 覆蓋：
 *   - v1 200 形狀 { v: 1, staff: [...] }（response 升級 — 裸陣列已淘汰）
 *   - 合併行為同舊 route 一致（同一人兩班合併 min/max）
 *   - 404 / 400 / 401
 *   - 舊 path 302 redirect（query passthrough）— wa-inbox 未切，保留
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from '../../../../../lib/prisma'
import { GET as GET_V1 } from './route'
import { GET as GET_LEGACY } from '../../duty-roster/route'

type Any = any

const KEY_MAIN = 'ext-test-key-main-0000000000000000000000000000000000000000000000000000'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const KEY_ROWS = [
  { id: 'k-main', name: 'dr-key-main', keyHash: sha(KEY_MAIN), scopes: ['availability', 'duty-roster'], active: true, lastUsedAt: null },
]

const CLINIC = { id: 'cl-wong', shortName: '旺' }
// 固定班表（fake 唔 filter where — 只驗形狀/合併邏輯）
const EMP_SHIFTS = [
  { startTime: new Date('2026-08-21T09:00:00+08:00'), endTime: new Date('2026-08-21T12:00:00+08:00'), role: 'Nurse', employee: { id: 'e1', user: { name: 'Wong Siu-Ming' } } },
  { startTime: new Date('2026-08-21T13:00:00+08:00'), endTime: new Date('2026-08-21T17:00:00+08:00'), role: null, employee: { id: 'e1', user: { name: 'Wong Siu-Ming' } } },
]
const PROVIDER_SHIFTS = [
  { startTime: new Date('2026-08-21T10:00:00+08:00'), endTime: new Date('2026-08-21T14:00:00+08:00'), provider: { id: 'p1', name: 'Dr. Wong' } },
]

const auditCreates: Any[] = []
let clinicFound = true

const fakes = {
  externalApiKey: { findMany: async () => KEY_ROWS, update: async () => ({}) },
  externalApiAudit: { create: async (args: Any) => { auditCreates.push(args.data); return {} } },
  clinic: { findFirst: async () => (clinicFound ? CLINIC : null) },
  shift: { findMany: async () => EMP_SHIFTS },
  providerShift: { findMany: async () => PROVIDER_SHIFTS },
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
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
})
beforeEach(() => {
  auditCreates.length = 0
  clinicFound = true
})

function mkV1(query: string, key?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (key) headers['x-api-key'] = key
  return new NextRequest(`http://localhost:3000/api/external/v1/duty-roster?${query}`, { headers })
}

describe('GET /api/external/v1/duty-roster', () => {
  it('200 形狀 { v:1, staff:[...] } + 兩班合併（min start / max end）', async () => {
    const res = await GET_V1(mkV1('clinicCode=旺&date=2026-08-21', KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.v, 1)
    assert.equal(body.staff.length, 2)
    // 合併：Nurse 兩班 → 09:00–17:00 一行
    assert.deepEqual(body.staff[0], {
      staffName: 'Wong Siu-Ming',
      role: 'Nurse',
      shiftStart: '09:00',
      shiftEnd: '17:00',
    })
    assert.deepEqual(body.staff[1], {
      staffName: 'Dr. Wong',
      role: 'Doctor',
      shiftStart: '10:00',
      shiftEnd: '14:00',
    })
    // 白名單欄位（PII 鐵律：冇 id/payroll/email/phone）
    for (const s of body.staff) {
      assert.deepEqual(Object.keys(s).sort(), ['role', 'shiftEnd', 'shiftStart', 'staffName'])
    }
  })

  it('clinicId compat alias（舊 query passthrough）', async () => {
    const res = await GET_V1(mkV1('clinicId=cl-wong&date=2026-08-21', KEY_MAIN))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.staff.length, 2)
  })

  it('無當值 → 200 { v:1, staff: [] }', async () => {
    const savedShifts = (fakes.shift as Any).findMany
    const savedPs = (fakes.providerShift as Any).findMany
    ;(fakes.shift as Any).findMany = async () => []
    ;(fakes.providerShift as Any).findMany = async () => []
    const res = await GET_V1(mkV1('clinicCode=旺&date=2026-08-21', KEY_MAIN))
    ;(fakes.shift as Any).findMany = savedShifts
    ;(fakes.providerShift as Any).findMany = savedPs
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { v: 1, staff: [] })
  })

  it('404 CLINIC_NOT_FOUND', async () => {
    clinicFound = false
    const res = await GET_V1(mkV1('clinicCode=NOPE&date=2026-08-21', KEY_MAIN))
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'clinic not found', code: 'CLINIC_NOT_FOUND' })
  })

  it('400：缺 clinicCode / 格式錯 date', async () => {
    const r1 = await GET_V1(mkV1('date=2026-08-21', KEY_MAIN))
    assert.equal(r1.status, 400)
    const r2 = await GET_V1(mkV1('clinicCode=旺&date=2026/08/21', KEY_MAIN))
    assert.equal(r2.status, 400)
  })

  it('401：無 key', async () => {
    const res = await GET_V1(mkV1('clinicCode=旺&date=2026-08-21'))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.code, 'UNAUTHORIZED')
  })
})

describe('舊 path 302 redirect（wa-inbox 未切 — 保留）', () => {
  it('302 → /api/external/v1/duty-roster + query passthrough（clinicId 原樣）', async () => {
    const req = new NextRequest('http://localhost:3000/api/external/duty-roster?clinicId=旺&date=2026-08-21')
    const res = await GET_LEGACY(req)
    assert.equal(res.status, 302)
    const loc = res.headers.get('location')!
    assert.match(loc, /\/api\/external\/v1\/duty-roster\?/)
    const u = new URL(loc)
    assert.equal(u.searchParams.get('clinicId'), '旺')
    assert.equal(u.searchParams.get('date'), '2026-08-21')
  })
})
