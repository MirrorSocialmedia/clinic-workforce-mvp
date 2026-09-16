import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractRxCodes, noteTextToPlain } from './extract-rx-codes'
import { parseLlmQuoteResponse } from './quote-extract'
import type { TermEntry } from './quote-parser'

const TERMS: TermEntry[] = [
  { shorthand: 'x', nameCn: '拔牙', nameEn: 'EXTRACTION', active: true },
  { shorthand: 'implant', nameCn: '植牙', nameEn: 'IMPLANT', active: true },
  { shorthand: 'br', nameCn: '牙橋', nameEn: 'BRIDGE', active: true },
  { shorthand: 'SP', nameCn: '洗牙', nameEn: 'SCALING', active: true },
  { shorthand: 'rsd', nameCn: '牙根刮治', nameEn: 'ROOT PLANING', active: true },
]

test('extractRxCodes: STANDARD note 命中 nameEn（case-insensitive）', () => {
  const note: any = { kind: 'STANDARD', complaints: 'pain', findings: 'given amoxicillin 500mg tds', diagnosis: 'abscess', actions: 'review in 1 week' }
  const rx = [
    { code: 'AMOX', nameEn: 'AMOXICILLIN', nameCn: '阿莫西林', active: true },
    { code: 'IBU', nameEn: 'IBUPROFEN', nameCn: null, active: true },
  ]
  assert.deepEqual(extractRxCodes(note, rx), ['AMOX'])
})

test('extractRxCodes: TEMPLATE note 命中 nameCn + 去重', () => {
  const note: any = { kind: 'TEMPLATE', blocks: [{ text: '處方：阿莫西林 三天' }, { text: '阿莫西林 500mg' }] }
  const rx = [
    { code: 'AMOX', nameEn: 'AMOXICILLIN', nameCn: '阿莫西林', active: true },
    { code: 'CIPRO', nameEn: 'CIPROFLOXACIN', nameCn: null, active: false }, // inactive 唔計
  ]
  assert.deepEqual(extractRxCodes(note, rx), ['AMOX'])
})

test('extractRxCodes: 無中 = 空陣列', () => {
  const note: any = { kind: 'STANDARD', complaints: 'crown loose', findings: '', diagnosis: '', actions: 'tightened' }
  const rx = [{ code: 'AMOX', nameEn: 'AMOXICILLIN', nameCn: '阿莫西林', active: true }]
  assert.deepEqual(extractRxCodes(note, rx), [])
})

test('extractRxCodes: word boundary — AMOX 唔會誤中 AMOXIL（假藥名）', () => {
  const note: any = { kind: 'STANDARD', complaints: '', findings: 'amoxil suspension given', diagnosis: '', actions: '' }
  const rx = [{ code: 'AMOX', nameEn: 'AMOXICILLIN', nameCn: null, active: true }]
  assert.deepEqual(extractRxCodes(note, rx), [])
})

test('noteTextToPlain: null / 空', () => {
  assert.equal(noteTextToPlain(null), '')
  assert.equal(noteTextToPlain({ kind: 'STANDARD', complaints: '', findings: '', diagnosis: '', actions: '' }), '')
})

test('parseLlmQuoteResponse: 收字典 code + strip fence', () => {
  const content = '```json\n{"items":[{"text":"implant 31 41","code":"IMPLANT","amount":31000,"perUnit":true},{"text":"weird term","code":"ZZZ","amount":100},{"text":"br","code":"br","amount":5500,"perUnit":true}]}\n```'
  const out = parseLlmQuoteResponse(content, TERMS)
  assert.ok(out)
  assert.equal(out!.length, 3)
  assert.equal(out![0].code, 'implant') // 正規化返字典原 case
  assert.equal(out![1].code, null) // 唔喺字典 → null（唔准自由發明）
  assert.equal(out![2].code, 'br')
  assert.equal(out![2].perUnit, true)
})

test('parseLlmQuoteResponse: 爛 JSON → null', () => {
  assert.equal(parseLlmQuoteResponse('not json at all', TERMS), null)
  assert.equal(parseLlmQuoteResponse('{"nope":true}', TERMS), null)
})
