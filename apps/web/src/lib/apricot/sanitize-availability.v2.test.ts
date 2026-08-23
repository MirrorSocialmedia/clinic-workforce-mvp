/**
 * 白名單 v2 tests（read-chain MD §1）— cwc-rdchain-20260823-a1
 *
 * 覆蓋：
 *   - 准入：visitReasons[].des / remarks / visit 日期 / 醫生欄位 / patient id/code/fullName
 *   - 變形：phoneNum 只准 HMAC hash 形式落地（raw 即棄；+852 變體同 hash）
 *   - 照禁：HKID / 地址 / DOB / medicalHistory / drugHistory / 緊急聯絡人 / 電郵 /
 *     bloodType / occupation / diagnosis / createdBy — bait 照掃
 *   - assertNoPii key 掃描語義：raw object key 漏過 → throw；
 *     白名單自由文字（remarks 入面 "email" 單詞）唔假陽性
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractIndexRows, assertNoPii } from './sanitize-availability'
import { addDaysStr } from '../hk-date'

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../testdata/phone-hash.fixture.json'), 'utf8'),
) as { key: string; hash: string }

before(() => {
  process.env.PHONE_HASH_KEY = fixture.key
})

const DATE = '2026-08-23'

function hkIso(dateStr: string, min: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60) - 8 * 3600_000).toISOString()
}

/** 白名單內 booking（v2 准入欄位齊） */
function mkBooking(over: Record<string, any> = {}): any {
  return {
    id: 'apt-001',
    bookingTime: hkIso(DATE, 570),
    bookingEndTime: hkIso(DATE, 600),
    bookingStatus: 0,
    isRemoved: false,
    visitReasons: [{ code: 'RV01', des: 'FILLING' }, { code: 'RV02', des: 'IMPLANT IMPRESSION' }],
    remarkByDoctor: '覆診跟進',
    clinicPatient: {
      id: 'pat-001',
      code: 'TKW001991',
      fullName: '陳大文',
      phoneNum: '91234567',
    },
    ...over,
  }
}
/** 禁類 bait 全數塞入（MD §1 🔴 照禁清單） */
function withBait(over: Record<string, any> = {}): any {
  return {
    ...mkBooking(over),
    diagnosis: 'DENTAL PAIN (bait)',
    createdBy: 'JOAN TEST NURSE',
    clinicPatient: {
      id: 'pat-001',
      code: 'TKW001991',
      fullName: '陳大文',
      phoneNum: '91234567',
      personalIdentifier: 'A123456(7)',
      address: '旺角彌敦道 12 號',
      dateOfBirth: '1975-04-01',
      medicalHistory: '高血壓 (bait)',
      drugHistory: '阿士匹靈 (bait)',
      emergencyContact: { name: 'CHAN MOK (bait)', phone: '98765432' },
      email: 'patient-bait@example.com',
      phoneList: [{ number: '91234567' }],
      bloodType: 'A+',
      occupation: 'ENGINEER',
      gender: 'M',
      billOsAmt: 123.4,
    },
  }
}

describe('extractIndexRows — 白名單 v2 准入', () => {
  it('visitReasons[].des + remarks + 日期 + patient id/code/fullName 照收', () => {
    const rows = extractIndexRows(DATE, { bookingDetail: [mkBooking()] })
    assert.equal(rows.length, 1)
    const r = rows[0]
    assert.equal(r.apricotApptId, 'apt-001')
    assert.equal(r.bookingStatus, 0)
    assert.equal(r.date, DATE)
    assert.equal(r.startTime, '09:30')
    assert.equal(r.endTime, '10:00')
    assert.equal(r.patientApricotId, 'pat-001')
    assert.equal(r.patientCode, 'TKW001991')
    assert.equal(r.patientName, '陳大文')
    assert.deepEqual(r.visitReasons, ['FILLING', 'IMPLANT IMPRESSION'])
    assert.equal(r.remarks, '覆診跟進')
  })

  it('phoneNum 只准 HMAC hash 落地：raw 即棄；fixture key 下 = 固定向量值', () => {
    const rows = extractIndexRows(DATE, { bookingDetail: [mkBooking()] })
    assert.equal(rows[0].phoneHash, fixture.hash, '91234567 → fixture 固定向量')
    assert.match(rows[0].phoneHash, /^[0-9a-f]{64}$/)
    const json = JSON.stringify(rows)
    assert.ok(!json.includes('91234567'), 'raw phoneNum 落咗 sanitized output')
  })

  it('phoneNum 852 前綴變體 → 同 hash（+852 9123-4567 = 91234567）', () => {
    const a = extractIndexRows(DATE, { bookingDetail: [mkBooking({ clinicPatient: { id: 'p1', phoneNum: '+852 9123-4567' } })] })
    const b = extractIndexRows(DATE, { bookingDetail: [mkBooking({ id: 'apt-002', clinicPatient: { id: 'p1', phoneNum: '91234567' } })] })
    assert.equal(a[0].phoneHash, b[0].phoneHash)
    assert.equal(a[0].phoneHash, fixture.hash)
  })

  it('phoneNum 缺失 → phoneHash 空字串（唔 hash 空串 — 防「無電話病人」互相 match）', () => {
    const rows = extractIndexRows(DATE, { bookingDetail: [mkBooking({ clinicPatient: { id: 'p1', code: 'P1', fullName: 'X' } })] })
    assert.equal(rows[0].phoneHash, '')
  })

  it('缺省欄位：visitReasons 缺 → []；remarks 空 → null；bookingStatus 缺 → -1', () => {
    const rows = extractIndexRows(DATE, {
      bookingDetail: [mkBooking({ id: 'apt-003', visitReasons: undefined, remarkByDoctor: '   ', bookingStatus: undefined })],
    })
    assert.deepEqual(rows[0].visitReasons, [])
    assert.equal(rows[0].remarks, null)
    assert.equal(rows[0].bookingStatus, -1)
  })
})

describe('extractIndexRows — 跳過規則（同 extractBookings 口徑）', () => {
  it('isRemoved / 跨日 / 無 appt id / 無 patient id → 唔入 index', () => {
    const rows = extractIndexRows(DATE, {
      bookingDetail: [
        mkBooking({ id: 'a1', isRemoved: true }),
        // 跨日筆：HK 前一日 22:00–22:30 → HK 日期 ≠ node 日期，必被跳過
        mkBooking({ id: 'a2', bookingTime: hkIso(addDaysStr(DATE, -1), 1320), bookingEndTime: hkIso(addDaysStr(DATE, -1), 1350) }),
        { ...mkBooking(), id: null },
        { ...mkBooking({ id: 'a4' }), clinicPatient: { code: 'X' } }, // 無 id
      ],
    })
    assert.equal(rows.length, 0)
  })

  it('壞 shape：bookingDetail 唔係 array → []', () => {
    assert.deepEqual(extractIndexRows(DATE, { bookingDetail: 'oops' }), [])
    assert.deepEqual(extractIndexRows(DATE, {}), [])
  })
})

describe('白名單 v2 — 禁類 bait 照拒', () => {
  it('bait 全塞入 → 輸出零污染 + assertNoPii 通過', () => {
    const rows = extractIndexRows(DATE, { bookingDetail: [withBait()] })
    assert.equal(rows.length, 1)
    const json = JSON.stringify(rows)
    for (const leak of [
      // keys
      'clinicPatient', 'personalIdentifier', 'medicalHistory', 'drugHistory',
      'phoneNum', 'phoneList', 'dateOfBirth', 'address', 'email',
      'emergencyContact', 'bloodType', 'occupation', 'diagnosis', 'createdBy',
      'gender', 'billOsAmt',
      // values
      'A123456(7)', '旺角', '1975-04-01', '高血壓', '阿士匹靈',
      'CHAN MOK', '98765432', 'patient-bait@example.com', 'A+', 'ENGINEER',
      'DENTAL PAIN', 'JOAN TEST NURSE',
    ]) {
      assert.ok(!json.includes(leak), `sanitized index row 出現禁類：${leak}`)
    }
    assertNoPii(rows) // 落地前 assert 唔假陽性
  })
})

describe('assertNoPii — key 掃描語義（v2 升級）', () => {
  it('raw object key 漏過（任何深度）→ throw', () => {
    assert.throws(() => assertNoPii({ a: { clinicPatient: { phoneNum: 'x' } } }), /PII 洩漏：clinicPatient/)
    assert.throws(() => assertNoPii([{ phoneNum: 'x' }]), /PII 洩漏：phoneNum/)
    assert.throws(() => assertNoPii({ fullName: 'x' }), /PII 洩漏：fullName/)
    assert.throws(() => assertNoPii({ a: [{ b: { emergencyContact: {} } }] }), /PII 洩漏：emergencyContact/)
  })

  it('白名單自由文字唔假陽性：remarks/visitReasons 值入面 "email" 單詞 → 唔 throw', () => {
    // 舊子串語義呢度會假陽性 throw（'email' 子串）— key 語義無事
    assert.doesNotThrow(() =>
      assertNoPii([{ remarks: 'patient to email the treatment plan', visitReasons: ['CALLBACK BY EMAIL'] }]),
    )
  })

  it('白名單 v2 object（visitReasons/remarks key 准入）→ 唔 throw', () => {
    const rows = extractIndexRows(DATE, { bookingDetail: [withBait({ remarkByDoctor: 'email patient later' })] })
    assert.doesNotThrow(() => assertNoPii(rows))
  })
})
