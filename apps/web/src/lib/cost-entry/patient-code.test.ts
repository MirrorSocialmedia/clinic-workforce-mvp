/**
 * cwm-labdoc P2 — §6.5 病人編號正規化測試（spec §15.2 清單）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normPatientCode, normShortName } from './patient-code'

test('7159 @TW → TW007159', () => {
  assert.equal(normPatientCode('7159', 'TW'), 'TW007159')
})

test('TY9845 → TY009845（字母前綴補零）', () => {
  assert.equal(normPatientCode('TY9845', null), 'TY009845')
})

test('#7595 @TW → TW007595（去 #）', () => {
  assert.equal(normPatientCode('#7595', 'TW'), 'TW007595')
})

test('tw8899 → TW008899（轉大階）', () => {
  assert.equal(normPatientCode('tw8899', null), 'TW008899')
})

test('2886 @青（中文 shortName）→ null（唔自動配對）', () => {
  assert.equal(normPatientCode('2886', '青'), null)
})

test('0172649（7 位純數字）→ null（> 6 位唔處理）', () => {
  assert.equal(normPatientCode('0172649', null), null)
  assert.equal(normPatientCode('0172649', 'TW'), null)
})

test('前置 0 保留：7 位純數字 → null；0254 @TW → TW000254（補零保留前置 0）', () => {
  assert.equal(normPatientCode('0254131', 'TW'), null) // 7 位 → 規則 4
  assert.equal(normPatientCode('0254', 'TW'), 'TW000254')
})

test('空格 / 大階 / 前綴 0 處理', () => {
  assert.equal(normPatientCode('  TY 9845 ', null), 'TY009845')
  assert.equal(normPatientCode('TKW02004', null), 'TKW002004')
  assert.equal(normPatientCode('TY000000', null), 'TY000000')
})

test('短名淨化：非英文字母 → null', () => {
  assert.equal(normShortName('青'), null)
  assert.equal(normShortName(' tw '), 'TW')
  assert.equal(normShortName(null), null)
  assert.equal(normShortName('47'), null) // 純數字唔算前綴（保守）
})
