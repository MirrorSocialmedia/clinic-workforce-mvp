/**
 * cwm-labdoc P1 — T8 加密存檔單測（§15.2：encrypt → decrypt 一樣；改一 byte → throw；舊 kid 解得）
 * 跑法: npx tsx --test src/lib/labdoc/crypto.test.ts
 *
 * 純 node:crypto + env — 無 prisma、無 fs。
 * 覆蓋：
 *   - round-trip：encrypt → decrypt 逐 byte 相同
 *   - 碟上格式：LDOC1 header（magic|kid|iv12|tag16|ct），blob 唔含明文
 *   - key 錯誤拒：現行 key 換咗 → GCM tag 驗證失敗 throw
 *   - AAD/內容篡改：ciphertext 改一 byte → throw；tag 改一 byte → throw
 *   - bad magic / 檔太短 → throw
 *   - 換 key：舊 kid 經 LAB_DOC_ENC_KEYS_OLD 解得；新檔用新 kid；舊 kid 未補 → throw
 *   - kid > 2 字 → throw
 *   - assertEncryptionConfigured：未設／base64 唔夠 32 bytes → throw
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  encrypt,
  decrypt,
  getKeyForKid,
  getCurrentKid,
  assertEncryptionConfigured,
} from './crypto'

const KEY_A = randomBytes(32).toString('base64')
const KEY_B = randomBytes(32).toString('base64')
const BASE_ENV: Record<string, string | undefined> = {
  LAB_DOC_ENC_KEY: KEY_A,
  LAB_DOC_ENC_KID: 'k1',
  LAB_DOC_ENC_KEYS_OLD: undefined,
}

const OLD_ENV: Record<string, string | undefined> = {}
function setEnv(patch: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

before(() => {
  for (const k of ['LAB_DOC_ENC_KEY', 'LAB_DOC_ENC_KID', 'LAB_DOC_ENC_KEYS_OLD']) {
    OLD_ENV[k] = process.env[k]
  }
  setEnv({ LAB_DOC_ENC_KEY: KEY_A, LAB_DOC_ENC_KID: 'k1', LAB_DOC_ENC_KEYS_OLD: undefined })
})
after(() => setEnv(OLD_ENV))

describe('T8 加密存檔 — §4.1 LDOC1（AES-256-GCM）', () => {
  it('round-trip：encrypt → decrypt 逐 byte 相同', () => {
    setEnv(BASE_ENV)
    const plain = randomBytes(4096)
    const blob = encrypt(plain)
    const { plain: out, kid } = decrypt(blob)
    assert.ok(out.equals(plain), '解密結果必須同原文逐 byte 相同')
    assert.equal(kid, 'k1')
  })

  it('碟上格式：LDOC1 header（magic|kid|iv12|tag16|ct）；blob 唔含明文', () => {
    setEnv(BASE_ENV)
    const plain = Buffer.from('LDOC1-PLAINTEXT-MUST-NEVER-APPEAR-ON-DISK-0123456789')
    const blob = encrypt(plain)
    assert.equal(blob.subarray(0, 5).toString('ascii'), 'LDOC1')
    assert.equal(blob.subarray(5, 7).toString('ascii'), 'k1')
    assert.ok(blob.length >= 5 + 2 + 12 + 16 + plain.length)
    assert.ok(!blob.includes(plain), '加密 blob 唔可以含明文子串')
  })

  it('key 錯誤拒：現行 key 唔同 → GCM tag 驗證失敗 throw', () => {
    setEnv(BASE_ENV)
    const blob = encrypt(randomBytes(256))
    setEnv({ LAB_DOC_ENC_KEY: KEY_B }) // kid 都係 k1，但 key 唔同
    assert.throws(() => decrypt(blob), /GCM tag/)
  })

  it('內容篡改：ciphertext 改一 byte → throw', () => {
    setEnv(BASE_ENV)
    const blob = encrypt(randomBytes(256))
    blob[blob.length - 1] ^= 0x01
    assert.throws(() => decrypt(blob), /GCM tag/)
  })

  it('AAD 位置篡改：tag 改一 byte → throw（tag offset = 5+2+12 = 19）', () => {
    setEnv(BASE_ENV)
    const blob = encrypt(randomBytes(256))
    blob[19] ^= 0x01
    assert.throws(() => decrypt(blob), /GCM tag/)
  })

  it('IV 篡改：改一 byte → throw（IV 參與 GCM auth）', () => {
    setEnv(BASE_ENV)
    const blob = encrypt(randomBytes(256))
    blob[7] ^= 0x01 // IV 區（5+2 .. 5+2+12）
    assert.throws(() => decrypt(blob), /GCM tag/)
  })

  it('bad magic → throw', () => {
    setEnv(BASE_ENV)
    const blob = encrypt(randomBytes(16))
    blob[0] = 0x58 // 'X'
    assert.throws(() => decrypt(blob), /magic/)
  })

  it('檔太短（< header 35 bytes）→ throw', () => {
    assert.throws(() => decrypt(Buffer.from('LDOC1xx')), /too small/)
  })

  it('換 key：舊 kid 經 LAB_DOC_ENC_KEYS_OLD 解得；新檔用新 kid；舊 kid 未補 → throw', () => {
    // 模擬：k1（KEY_A）用緊 → 換到 k2（KEY_B）
    setEnv(BASE_ENV)
    const oldBlob = encrypt(randomBytes(64)) // 現行 kid = k1（KEY_A）
    setEnv({ LAB_DOC_ENC_KEY: KEY_B, LAB_DOC_ENC_KID: 'k2', LAB_DOC_ENC_KEYS_OLD: `k1:${KEY_A}` })
    assert.equal(getCurrentKid(), 'k2')

    const { kid } = decrypt(oldBlob)
    assert.equal(kid, 'k1', '舊檔解到 = 舊 kid')
    assert.ok(getKeyForKid('k1')!.equals(Buffer.from(KEY_A, 'base64')))

    const cur = encrypt(randomBytes(32))
    assert.equal(cur.subarray(5, 7).toString('ascii'), 'k2', '新檔用新 kid')
    decrypt(cur) // 新檔用現行 key 照解得

    // 換 key 後 LAB_DOC_ENC_KEYS_OLD 忘補 → 舊檔解唔到（要 throw，唔好靜靜失敗）
    setEnv({ LAB_DOC_ENC_KEYS_OLD: undefined })
    assert.throws(() => decrypt(oldBlob), /key for kid/)
  })

  it('kid 超過 2 字 → encrypt throw（檔頭 KID_LEN=2）', () => {
    // 長 kid 要喺 KEYS_OLD 搵到 key 先至行到 length check（getKeyForKid 先於 KID_LEN 檢查）
    setEnv({ LAB_DOC_ENC_KEY: KEY_A, LAB_DOC_ENC_KID: 'k1', LAB_DOC_ENC_KEYS_OLD: `kid-too-long:${KEY_A}` })
    assert.throws(() => encrypt(Buffer.from('x'), 'kid-too-long'), /超過/)
  })

  it('assertEncryptionConfigured：未設／base64 解出唔夠 32 bytes → throw；設齊 → pass', () => {
    setEnv({ LAB_DOC_ENC_KEY: undefined, LAB_DOC_ENC_KID: 'k1' })
    assert.throws(() => assertEncryptionConfigured(), /LAB_DOC_ENC_KEY/)

    setEnv({ LAB_DOC_ENC_KEY: 'c2hvcnQ=' }) // 5 bytes
    assert.throws(() => assertEncryptionConfigured(), /LAB_DOC_ENC_KEY/)

    setEnv({ LAB_DOC_ENC_KEY: KEY_A })
    assert.doesNotThrow(() => assertEncryptionConfigured())
  })
})
