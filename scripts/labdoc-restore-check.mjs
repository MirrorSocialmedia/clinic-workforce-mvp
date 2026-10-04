#!/usr/bin/env node
/**
 * cwm-labdoc P1 — restore-drill 解密核對工具（§4.5）
 *
 * 用法：
 *   LAB_DOC_ENC_KEY=<base64 32B> node scripts/labdoc-restore-check.mjs <file.bin>
 *
 * 由備份（offsite 或本地 drill 目錄）拉返一個加密檔 → 解密 → 印 plaintext sha256。
 * exit 0 = 成功（stdout = sha256 hex）；exit 1 = 解密失敗（bad magic / key 錯 / tag 驗證失敗）。
 *
 * 檔頭（同 src/lib/labdoc/crypto.ts）：magic 'LDOC1'(5) | kid(2) | iv(12) | tag(16) | ciphertext
 * Key 解析同 crypto.ts：現行 kid 由 LAB_DOC_ENC_KEY + LAB_DOC_ENC_KID（預設 k1）；
 * 舊 kid 由 LAB_DOC_ENC_KEYS_OLD（'kid:base64,kid2:base64,…'）。
 * 刻意獨立實現（唔 import TS）— 生產 host 上 drill 要能冇 node_modules 都跑得。
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const MAGIC = Buffer.from('LDOC1', 'ascii')
const HEADER_LEN = 5 + 2 + 12 + 16

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

const [file] = process.argv.slice(2)
if (!file) fail('用法：LAB_DOC_ENC_KEY=... node labdoc-restore-check.mjs <file.bin>')

function keyForKid(kid) {
  const cur = process.env.LAB_DOC_ENC_KEY
  if (kid === (process.env.LAB_DOC_ENC_KID || 'k1')) {
    if (cur) {
      const b = Buffer.from(cur, 'base64')
      if (b.length === 32) return b
    }
    return null
  }
  const old = process.env.LAB_DOC_ENC_KEYS_OLD
  if (old) {
    for (const part of old.split(',')) {
      const idx = part.indexOf(':')
      if (idx <= 0) continue
      if (part.slice(0, idx).trim() !== kid) continue
      const b = Buffer.from(part.slice(idx + 1).trim(), 'base64')
      if (b.length === 32) return b
    }
  }
  return null
}

let buf
try {
  buf = readFileSync(file)
} catch (e) {
  fail(`讀唔到檔 ${file}: ${e.message}`)
}
if (buf.length < HEADER_LEN) fail('檔太細（唔係 LDOC1 格式）')
if (!buf.subarray(0, 5).equals(MAGIC)) fail('bad magic（唔係 LDOC1 檔）')

const kid = buf.subarray(5, 7).toString('ascii').replace(/\0+$/g, '').trim()
const iv = buf.subarray(7, 19)
const tag = buf.subarray(19, 35)
const ciphertext = buf.subarray(35)

const key = keyForKid(kid)
if (!key) fail(`key for kid "${kid}" 未設（LAB_DOC_ENC_KEY／LAB_DOC_ENC_KEYS_OLD？）`)

const decipher = createDecipheriv('aes-256-gcm', key, iv)
decipher.setAuthTag(tag)
let plain
try {
  plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
} catch {
  fail('GCM tag 驗證失敗（檔損壞或 key 錯）')
}

console.log(createHash('sha256').update(plain).digest('hex'))
