/**
 * ★ 2026-09-30：網絡失敗證據時間夾（punch-evidence.ts 純函數部分）
 *   規格 §10.1：只測純函數 evidenceTime —— 客戶端聲稱嘅時間只准喺
 *   [issuedAt, min(expiresAt, punchTime)] 入面移動。
 * 跑法: TZ=UTC npx tsx --test src/lib/punch-evidence.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceTime } from './punch-evidence'

describe('evidenceTime（§10.1 表列 5 情境）', () => {
  it('#1 聲稱時間喺窗口內 → 照用', () => {
    assert.equal(evidenceTime(0, 24000, 120000, 10000), 10000)
  })

  it('#2 聲稱早過發碼 → 夾返 issuedAt (0)', () => {
    assert.equal(evidenceTime(0, 24000, 120000, -5000), 0)
  })

  it('#3 聲稱遲過過期 → 夾返 expiresAt (24000)', () => {
    assert.equal(evidenceTime(0, 24000, 120000, 99999), 24000)
  })

  it("#4 聲稱唔係數字（'abc'）→ 當冇聲稱，用 issuedAt (0)", () => {
    assert.equal(evidenceTime(0, 24000, 120000, 'abc'), 0)
    assert.equal(evidenceTime(0, 24000, 120000, null), 0)
    assert.equal(evidenceTime(0, 24000, 120000, undefined), 0)
    assert.equal(evidenceTime(0, 24000, 120000, Number.NaN), 0)
  })

  it('#5 punchTime 早過 expiresAt → 上界係 punchTime (10000)', () => {
    assert.equal(evidenceTime(0, 24000, 10000, 20000), 10000)
  })

  it('issuedAt > 0 嘅窗口：全部邊界照夾', () => {
    // 聲稱早過發碼 → issuedAt
    assert.equal(evidenceTime(1000, 24000, 120000, 500), 1000)
    // 窗口內
    assert.equal(evidenceTime(1000, 24000, 120000, 20000), 20000)
  })
})
