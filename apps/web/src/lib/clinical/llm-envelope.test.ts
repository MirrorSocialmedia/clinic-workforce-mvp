// ============================================================
// llm-envelope — cwi-final S2-9b（workforce 側）
//
// 信封實作由 wa-clinic-inbox src/lib/internal/llm-envelope.ts 逐字複製
// （兩邊必須 byte-identical — commit 前 diff 核實，證據入 gates log）。
// 防兩邊實作漂移：
//   1. 固定 test vector（test/fixtures/llm-envelope.v1.json — 兩 repo 同一份檔）
//      → open 必須還原 body；context 改任何一字 → open throw（AAD 綁 context）
//   2. 固定 key seal → open round-trip 返原文
//   3. 錯 key → open throw
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { seal, open, REQ_CONTEXT, type Envelope } from './llm-envelope'

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '../../../test/fixtures/llm-envelope.v1.json'), 'utf8'),
) as {
  _meta: { secret_b64: string; kid: string; context: string; body: unknown }
  envelope: Envelope
}
const SECRET = FIXTURE._meta.secret_b64

test('S2-9b vector: open(fixture 信封, fixture key, req context) 還原 body', () => {
  const out = open<{ notePlain: string; terms: unknown[] }>(SECRET, FIXTURE.envelope, FIXTURE._meta.context)
  assert.deepEqual(out, FIXTURE._meta.body)
})

test('S2-9b vector: context 改一個字 → open throw（AAD 綁 context — 防兩邊實作漂移）', () => {
  assert.throws(() => open(SECRET, FIXTURE.envelope, `${FIXTURE._meta.context}X`))
  // resp context 格式（resp:llm-extract:<nonce>）都開唔到 req 信封
  assert.throws(() => open(SECRET, FIXTURE.envelope, `resp:llm-extract:${FIXTURE.envelope.nonce}`))
})

test('S2-9b: 固定 key seal → open 返原文（round-trip）', () => {
  const body = { notePlain: 'round-trip 測試（S2-9b）', terms: [{ shorthand: 'A1', nameCn: '測試項目A', nameEn: null }] }
  const env = seal(SECRET, 'k1', body, REQ_CONTEXT)
  assert.equal(env.v, 1)
  assert.equal(env.kid, 'k1')
  assert.deepEqual(open(SECRET, env, REQ_CONTEXT), body)
})

test('S2-9b: 錯 key → open throw', () => {
  const env = seal(SECRET, 'k1', { notePlain: 'x', terms: [] }, REQ_CONTEXT)
  // 錯 key = 同長（48 bytes base64）但唔同內容
  const wrongSecret = Buffer.from('cwi-s29b-test-key-00000000000000000000000000001').toString('base64')
  assert.notEqual(wrongSecret, SECRET)
  assert.throws(() => open(wrongSecret, env, REQ_CONTEXT))
})

test('S2-9b: 密文被改一個字 → open throw（tag 驗證）', () => {
  const env = seal(SECRET, 'k1', { notePlain: 'tamper check', terms: [] }, REQ_CONTEXT)
  const tampered = { ...env, ct: (env.ct[0] === 'A' ? 'B' : 'A') + env.ct.slice(1) }
  assert.throws(() => open(SECRET, tampered, REQ_CONTEXT))
})
