/**
 * phone-probe.ts 單測（cwi-patient-identify-probe-20261017）
 * 覆蓋：目標識別（HK 8 位／852／+852 空格；CN 11 位／86／+86）、搜尋寫法、跨格式比對、形狀遮罩。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { probeTarget, phoneSearchVariants, phoneFieldMatches, phoneShape, patientPhoneStrings } from './phone-probe'

describe('probeTarget', () => {
  it('香港各種寫法 → HK 8 位', () => {
    for (const s of ['91234567', '9123 4567', '+852 9123 4567', '85291234567', '(852) 9123-4567']) {
      assert.deepEqual(probeTarget(s), { kind: 'HK', core: '91234567' }, s)
    }
  })
  it('內地各種寫法（包括冇國碼 11 位）→ CN 11 位', () => {
    for (const s of ['13812345678', '8613812345678', '+86 138 1234 5678', '+8613812345678']) {
      assert.deepEqual(probeTarget(s), { kind: 'CN', core: '13812345678' }, s)
    }
  })
  it('認唔到 → null', () => {
    assert.equal(probeTarget('123'), null)
    assert.equal(probeTarget(''), null)
  })
})

describe('phoneSearchVariants', () => {
  it('HK 有 8 位、空格、橫線、852、+852', () => {
    const v = phoneSearchVariants({ kind: 'HK', core: '91234567' })
    for (const x of ['91234567', '9123 4567', '9123-4567', '85291234567', '+85291234567']) assert.ok(v.includes(x), x)
  })
  it('CN 有 11 位、86、+86、空格', () => {
    const v = phoneSearchVariants({ kind: 'CN', core: '13812345678' })
    for (const x of ['13812345678', '8613812345678', '+8613812345678', '138 1234 5678']) assert.ok(v.includes(x), x)
  })
})

describe('phoneFieldMatches', () => {
  const hk = { kind: 'HK' as const, core: '91234567' }
  const cn = { kind: 'CN' as const, core: '13812345678' }
  it('同一個號碼唔理格式都對到', () => {
    for (const f of ['91234567', '9123 4567', '9123-4567', '+852 9123 4567', '85291234567', '61234567 / 9123 4567', '6123 4567 9123 4567']) {
      assert.ok(phoneFieldMatches(f, hk), f)
    }
    for (const f of ['13812345678', '+86 138 1234 5678', '86-138-1234-5678']) assert.ok(phoneFieldMatches(f, cn), f)
  })
  it('唔同號碼唔對', () => {
    for (const f of ['91234568', '6123 4567', '']) assert.equal(phoneFieldMatches(f, hk), false, f)
  })
})

describe('phoneShape / patientPhoneStrings', () => {
  it('形狀唔含數字', () => {
    assert.equal(phoneShape('+852 9123 4567'), '+ddd dddd dddd')
  })
  it('phoneNum + phoneList 都攞到', () => {
    assert.deepEqual(patientPhoneStrings({ phoneNum: '91234567', phoneList: [{ type: 'mobile', number: '61234567' }] }), ['91234567', '61234567'])
  })
})
