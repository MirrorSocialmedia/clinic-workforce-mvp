/**
 * phone-hash 固定向量 tests（read-chain MD §2.3）— cwc-rdchain-20260823-a1
 *
 * 鐵律：src/lib/phone-hash.ts 內容鎖死（將來 wa-inbox 一字一樣抄走）。
 * normalize drift = 兩邊 match 靜默全失效 → 固定向量 + 全變體 test 釘住。
 *
 * 向量值寫入 testdata/phone-hash.fixture.json（固定 test key）—
 * 將來 wa-inbox 用同一份 fixture 對照，hash 一致 = 兩 repo 同步。
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizePhone, phoneHash } from './phone-hash'

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../testdata/phone-hash.fixture.json'), 'utf8'),
) as { key: string; canonical: string; hash: string; variants: string[] }

before(() => {
  process.env.PHONE_HASH_KEY = fixture.key
})

describe('normalizePhone — HK 取尾 8；海外全碼', () => {
  it('去非數字', () => {
    assert.equal(normalizePhone('+852 9123-4567'), '91234567')
    assert.equal(normalizePhone('(852) 9123 4567'), '91234567')
    assert.equal(normalizePhone('91234567'), '91234567')
  })

  it('852 開頭 11 位 → 取尾 8', () => {
    assert.equal(normalizePhone('85291234567'), '91234567')
    assert.equal(normalizePhone('852 9123 4567'), '91234567')
  })

  it('非 852/非 11 位 → 全碼原樣（海外電話）', () => {
    assert.equal(normalizePhone('+1 415 555 2671'), '14155552671')
    // 852 開頭但唔係 11 位（例如 8 位舊格式 852xxx + 4 位）→ 唔切
    assert.equal(normalizePhone('852123456'), '852123456')
  })
})

describe('phoneHash — 固定向量（fixture 錨定，兩 repo 對照）', () => {
  it('全變體同 hash，且 = fixture 固定值', () => {
    const canonical = phoneHash(fixture.canonical)
    assert.equal(canonical, fixture.hash, 'canon hash 唔等 fixture 值 — phone-hash.ts 或 fixture 被改過')
    for (const v of fixture.variants) {
      assert.equal(phoneHash(v), fixture.hash, `variant ${v} 唔同 hash`)
    }
    // MD 字面向量
    assert.equal(phoneHash('+852 9123-4567'), phoneHash('91234567'))
  })

  it('輸出 = 64 位 hex', () => {
    assert.match(phoneHash('91234567'), /^[0-9a-f]{64}$/)
  })

  it('唔同電話 → 唔同 hash', () => {
    assert.notEqual(phoneHash('91234567'), phoneHash('98765432'))
  })

  it('key 唔同 → hash 唔同（key 係 part of 算法）', () => {
    const prev = process.env.PHONE_HASH_KEY
    process.env.PHONE_HASH_KEY = 'another-test-key-0123456789abcdef0123456789abcdef'
    try {
      assert.notEqual(phoneHash('91234567'), fixture.hash)
    } finally {
      process.env.PHONE_HASH_KEY = prev
    }
  })
})
