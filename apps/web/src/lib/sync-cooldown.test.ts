/**
 * ★ cw-pta: 「立即同步」cooldown 純邏輯測試
 * 跑法: cd apps/web && npx tsx --test src/lib/sync-cooldown.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkCooldown, SYNC_COOLDOWN_MS } from './sync-cooldown'

const T0 = 1_000_000 // 基準時間戳（ms）

describe('checkCooldown — 60s cooldown 按 userId（拍板②）', () => {
  it('從冇 sync 過 → allowed', () => {
    const m = new Map<string, number>()
    assert.deepEqual(checkCooldown(m, 'u1', T0), { allowed: true })
  })

  it('sync 咗即刻 → 第二次即刻擋（429），retryAfterMs = 剩餘毫秒', () => {
    const m = new Map<string, number>()
    m.set('u1', T0) // t=T0 時 sync 咗
    const d1 = checkCooldown(m, 'u1', T0)
    assert.equal(d1.allowed, false)
    assert.equal(d1.retryAfterMs, SYNC_COOLDOWN_MS)
    const d2 = checkCooldown(m, 'u1', T0 + 1)
    assert.equal(d2.allowed, false)
    assert.equal(d2.retryAfterMs, SYNC_COOLDOWN_MS - 1)
  })

  it('59s 後 → 仍然擋住（retryAfterMs 正確倒數）', () => {
    const m = new Map<string, number>()
    m.set('u1', T0)
    const d = checkCooldown(m, 'u1', T0 + SYNC_COOLDOWN_MS - 1000)
    assert.equal(d.allowed, false)
    assert.equal(d.retryAfterMs, 1000)
  })

  it('60s 整到期 → allowed（left=0 唔算擋）', () => {
    const m = new Map<string, number>()
    m.set('u1', T0)
    assert.equal(checkCooldown(m, 'u1', T0 + SYNC_COOLDOWN_MS).allowed, true)
    assert.equal(checkCooldown(m, 'u1', T0 + SYNC_COOLDOWN_MS + 5).allowed, true)
  })

  it('唔同 userId 唔會互相擋', () => {
    const m = new Map<string, number>()
    m.set('u1', T0)
    assert.equal(checkCooldown(m, 'u1', T0 + 1).allowed, false)
    assert.equal(checkCooldown(m, 'u2', T0 + 1).allowed, true)
  })

  it('上次 sync 之後又過咗 cooldown → 重新計', () => {
    const m = new Map<string, number>()
    m.set('u1', T0)
    m.set('u1', T0 + SYNC_COOLDOWN_MS + 1000) // 第二次 sync
    const d = checkCooldown(m, 'u1', T0 + SYNC_COOLDOWN_MS + 1001)
    assert.equal(d.allowed, false)
    assert.equal(d.retryAfterMs, SYNC_COOLDOWN_MS - 1)
  })
})
