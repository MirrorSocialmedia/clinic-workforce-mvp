/**
 * visit-index.ts 單測 — resolvePatientDay（純函數部分）
 * （cwi-followup-p1-20260915 S1/S2 — 錨點／爽約 -3／帳單合計／多號 hash／clinic 映射）
 *
 * upsertVisitIndex / rescanUpdateNote 係 DB 寫 — 由 e2e（決定性 stub）覆蓋。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePatientDay } from './visit-index'
import { phoneHashes } from '@/lib/phone'

const KEY = 'unit-phone-key-cwi-p1-0123456789'
const clinicMap = new Map([
  ['apr-ty-001', 'clinic-ty-id'],
  ['apr-tkw-001', 'clinic-tkw-id'],
])

const patient = { cpId: 'cp-std-001', code: 'P0001', phoneNum: '91234567' }

const apptStd = {
  id: 'apt-1',
  conTime: '2026-09-14T10:00:00.000Z', // UTC 格式（Apricot 實測）— 18:00 HK 仍係 9/14
  checkInTime: '2026-09-14T02:05:00.000Z',
  bookingStatus: 4,
  clinicId: 'apr-ty-001',
  visitReasons: [{ code: 'FILLING' }, { code: 'SCALE' }],
  providerCode: 'DR1',
}

describe('resolvePatientDay', () => {
  it('正常日 — appointment 錨點（conTime HK 日）+ note（bookingId 對接）+ 帳單合計', () => {
    const v = resolvePatientDay({
      patient,
      appointments: [apptStd],
      notes: [{ id: 'note-1', bookingId: 'apt-1', complaints: '牙痛', findings: '', diagnosis: '', actions: '' }],
      bills: [
        { id: 'b1', isVoid: false, ttlAmt: 500.5, osAmt: 200 },
        { id: 'b2', isVoid: false, ttlAmt: 299.5, osAmt: 100.4 },
        { id: 'b3', isVoid: true, ttlAmt: 9999, osAmt: 9999 }, // void → 剔除
      ],
      day: '2026-09-14',
      clinicMap,
      phoneKey: KEY,
    })
    assert.ok(v)
    assert.equal(v.clinicId, 'clinic-ty-id')
    assert.equal(v.patientApricotId, 'cp-std-001')
    assert.equal(v.patientCode, 'P0001')
    assert.equal(v.visitDate, '2026-09-14')
    assert.equal(v.apricotApptId, 'apt-1')
    assert.equal(v.apricotNoteId, 'note-1')
    assert.equal(v.bookingStatus, 4)
    assert.deepEqual(v.visitReasonCodes, ['FILLING', 'SCALE'])
    assert.equal(v.providerCode, 'DR1')
    assert.equal(v.hasNote, true)
    assert.equal(v.noteKind, 'STANDARD')
    assert.deepEqual(v.phoneHashes, phoneHashes('91234567', KEY))
    assert.equal(v.billTtlAmt, 800) // round(500.5+299.5)
    assert.equal(v.billOsAmt, 300) // round(200+100.4)
  })

  it('🔴 鐵律 7：爽約 bookingStatus=-3 原樣入（唔係 >=0 過濾）', () => {
    const v = resolvePatientDay({
      patient: { cpId: 'cp-no-003', code: 'P0003', phoneNum: '85291234567' },
      appointments: [{ ...apptStd, id: 'apt-3', clinicId: 'apr-tkw-001', bookingStatus: -3, conTime: '2026-09-14T01:00:00.000Z' }],
      notes: [],
      bills: [],
      day: '2026-09-14',
      clinicMap,
      phoneKey: KEY,
    })
    assert.ok(v)
    assert.equal(v.bookingStatus, -3)
    assert.equal(v.hasNote, false)
    assert.equal(v.noteJson, null)
    assert.equal(v.billTtlAmt, null) // 無 bill → null（唔係 0）
  })

  it('該日無 appointment → null（walk-in 無錨點 — P1 唔索引）', () => {
    const v = resolvePatientDay({
      patient,
      appointments: [{ ...apptStd, conTime: '2026-09-10T02:00:00.000Z' }],
      notes: [],
      bills: [],
      day: '2026-09-14',
      clinicMap,
      phoneKey: KEY,
    })
    assert.equal(v, null)
  })

  it('UTC 日界：conTime 2026-09-13T18:00Z = HK 2026-09-14 02:00 → 錨點 9/14', () => {
    const v = resolvePatientDay({
      patient,
      appointments: [{ ...apptStd, conTime: '2026-09-13T18:00:00.000Z' }],
      notes: [],
      bills: [],
      day: '2026-09-14',
      clinicMap,
      phoneKey: KEY,
    })
    assert.ok(v) // slice(0,10) 做法會喺呢度紅（9/13 ≠ 9/14）
  })

  it('clinic 映射唔到 → null（dev clinic 未設 apricotClinicId）', () => {
    const v = resolvePatientDay({
      patient,
      appointments: [{ ...apptStd, clinicId: 'apr-unknown-999' }],
      notes: [],
      bills: [],
      day: '2026-09-14',
      clinicMap,
      phoneKey: KEY,
    })
    assert.equal(v, null)
  })

  it('多號電話 → 多 hash（MD §1.2；原始電話唔入結果）', () => {
    const v = resolvePatientDay({
      patient: { cpId: 'cp-tpl-002', code: 'P0002', phoneNum: '91234567/61234567' },
      appointments: [apptStd],
      notes: [],
      bills: [],
      day: '2026-09-14',
      clinicMap,
      phoneKey: KEY,
    })
    assert.ok(v)
    assert.deepEqual(v.phoneHashes, phoneHashes('91234567/61234567', KEY))
    assert.equal(v.phoneHashes.length, 2)
    assert.ok(!JSON.stringify(v).includes('91234567'))
    assert.ok(!JSON.stringify(v).includes('61234567'))
  })

  it('note 無 bookingId 匹配 → hasNote=false（唔濫配）', () => {
    const v = resolvePatientDay({
      patient,
      appointments: [apptStd],
      notes: [{ id: 'note-x', bookingId: 'apt-OTHER', complaints: 'x', findings: '', diagnosis: '', actions: '' }],
      bills: [],
      day: '2026-09-14',
      clinicMap,
      phoneKey: KEY,
    })
    assert.ok(v)
    assert.equal(v.hasNote, false)
    assert.equal(v.apricotNoteId, null)
  })
})
