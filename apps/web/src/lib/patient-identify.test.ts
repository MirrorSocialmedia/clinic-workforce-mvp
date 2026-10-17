/**
 * patient-identify 單測（cwi-patient-identify-20261017）— 搜尋寫法跟 2026-10-17 probe 實測：
 * Apricot keyword 用字串比對；「dddd dddd」同「dddddddd」搵到，帶國碼／橫線搵唔到。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { identifyKeywords } from './patient-identify'
import { probeTarget } from './apricot/phone-probe'

describe('identifyKeywords', () => {
  it('香港：空格分段 + 8 位（WhatsApp waId 852 開頭都得）', () => {
    assert.deepEqual(identifyKeywords(probeTarget('85291234567')!), ['9123 4567', '91234567'])
    assert.deepEqual(identifyKeywords(probeTarget('9123-4567')!), ['9123 4567', '91234567'])
  })
  it('內地：3-4-4 分段 + 11 位（86 開頭 waId）', () => {
    assert.deepEqual(identifyKeywords(probeTarget('8613812345678')!), ['138 1234 5678', '13812345678'])
  })
  it('其他國家：全數字', () => {
    assert.deepEqual(identifyKeywords(probeTarget('6591234567')!), ['6591234567'])
  })
})
