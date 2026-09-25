/**
 * cwi-final S5-5（W-6）：resolveClinicByCode 消歧（T814）
 *
 * 舊口徑 findFirst(OR shortName/id) → 兩間店同簡稱 = 隨機揀一間 → 落錯店。
 * 新口徑：cuid 精確優先 → shortName 唯一先過（0 行 404 / >1 行 400 AMBIGUOUS_CLINIC_CODE）。
 * DB 層另有 partial unique index 防新增重複（migration）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { basePrisma } from './prisma'
import { resolveClinicByCode } from './external-clinic'
import { ExternalApiError } from './external-api'

type Any = any

const CLINIC_A = { id: 'cl-aaa', shortName: '旺', apricotClinicId: 'apr-a' }
const CLINIC_B = { id: 'cl-bbb', shortName: '旺', apricotClinicId: 'apr-b' }
const CLINIC_SOLO = { id: 'cl-ccc', shortName: '中', apricotClinicId: 'apr-c' }

// 可控 fake：clinic 表（cuid 精確 / shortName 查找）
let clinicRows: Any[] = []
const fakes = {
  clinic: {
    findUnique: async ({ where }: Any) => clinicRows.find((r) => r.id === where.id) ?? null,
    findMany: async ({ where }: Any) => clinicRows.filter((r) => r.shortName === where.shortName),
  },
}

let saved: [Any, string, Any][] = []
before(() => {
  for (const k of Object.keys(fakes) as (keyof typeof fakes)[]) {
    saved.push([basePrisma, k, (basePrisma as Any)[k]])
    Object.defineProperty(basePrisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})
after(() => {
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
})

describe('T814 S5-5：resolveClinicByCode 消歧', () => {
  it('cuid call（findUnique 命中）→ 直接回該店（唔經 shortName 路）', async () => {
    clinicRows = [CLINIC_A, CLINIC_B] // 同簡稱兩間 — cuid 都應該無歧義
    const r = await resolveClinicByCode('cl-aaa')
    assert.deepEqual(r, CLINIC_A)
  })

  it('shortName 唯一（1 行）→ 200 解析', async () => {
    clinicRows = [CLINIC_SOLO]
    const r = await resolveClinicByCode('中')
    assert.deepEqual(r, CLINIC_SOLO)
  })

  it('兩間同 shortName → 400 AMBIGUOUS_CLINIC_CODE（唔好隨機揀）', async () => {
    clinicRows = [CLINIC_A, CLINIC_B]
    await assert.rejects(resolveClinicByCode('旺'), (e: Any) =>
      e instanceof ExternalApiError && e.status === 400 && e.code === 'AMBIGUOUS_CLINIC_CODE')
  })

  it('0 行 → 404 CLINIC_NOT_FOUND', async () => {
    clinicRows = [CLINIC_A]
    await assert.rejects(resolveClinicByCode('無'), (e: Any) =>
      e instanceof ExternalApiError && e.status === 404 && e.code === 'CLINIC_NOT_FOUND')
  })
})
