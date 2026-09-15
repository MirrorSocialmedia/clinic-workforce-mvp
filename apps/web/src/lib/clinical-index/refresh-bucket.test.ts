/**
 * refresh.ts token bucket 單測（cwi-followup-p1-20260915 S5 — MD §2.8 四層保護 1+2）
 *
 * 層 1：同一病人 60 秒一次（capacity 1 / 60s）
 * 層 2：全店每分鐘 20 次（capacity 20 / 60s）
 * clinic 拒時 patient token 還返（唔誤鎖病人 60 秒）
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { takeRefreshTokens, resetClinicalRefreshBuckets } from './refresh'

describe('refresh token bucket（MD §2.8）', () => {
  beforeEach(() => resetClinicalRefreshBuckets())

  it('層 1：同一病人第二次（<60s）→ 拒 + retryAfterSec ≈ 60', () => {
    const r1 = takeRefreshTokens('clinic-a', 'cp-1')
    assert.equal(r1.ok, true)
    const r2 = takeRefreshTokens('clinic-a', 'cp-1')
    assert.equal(r2.ok, false)
    assert.ok(r2.retryAfterSec >= 55 && r2.retryAfterSec <= 60, `retry=${r2.retryAfterSec}`)
  })

  it('層 1：唔同病人互唔影響（ clinic 額度內）', () => {
    assert.equal(takeRefreshTokens('clinic-a', 'cp-1').ok, true)
    assert.equal(takeRefreshTokens('clinic-a', 'cp-2').ok, true)
    assert.equal(takeRefreshTokens('clinic-a', 'cp-1').ok, false) // cp-1 自己鎖緊
    assert.equal(takeRefreshTokens('clinic-a', 'cp-3').ok, true)
  })

  it('層 2：全店 20 次用盡 → 第 21 人拒', () => {
    for (let i = 1; i <= 20; i++) {
      assert.equal(takeRefreshTokens('clinic-b', `cp-${i}`).ok, true, `第 ${i} 人應過`)
    }
    const r21 = takeRefreshTokens('clinic-b', 'cp-21')
    assert.equal(r21.ok, false)
    assert.ok(r21.retryAfterSec <= 5, `clinic 層 retry 應細（~3s），實際=${r21.retryAfterSec}`)
  })

  it('clinic 拒時 patient token 還返 — 病人唔會被誤鎖 60 秒', () => {
    // 用 20 人填晒 clinic bucket
    for (let i = 1; i <= 20; i++) takeRefreshTokens('clinic-c', `cp-fill-${i}`)
    // 第 21 人：patient bucket 過（首次）→ clinic 拒
    const r1 = takeRefreshTokens('clinic-c', 'cp-victim')
    assert.equal(r1.ok, false)
    // 立即再試同一病人：若 patient token 冇還返，retry 會 ≈60s；還咗先會係 clinic 層嘅 ~3s
    const r2 = takeRefreshTokens('clinic-c', 'cp-victim')
    assert.equal(r2.ok, false) // clinic 仍然空 — 拒
    assert.ok(r2.retryAfterSec <= 5, `還返後 retry 應係 clinic 層（~3s），實際=${r2.retryAfterSec}`)
  })

  it('唔同 clinic 互唔影響（patient cooldown 係 per-patient — 用未用過嘅病人）', () => {
    for (let i = 1; i <= 20; i++) takeRefreshTokens('clinic-x', `cp-${i}`)
    assert.equal(takeRefreshTokens('clinic-y', 'cp-900').ok, true) // 新 clinic 滿額度 + 未用過嘅病人
    assert.equal(takeRefreshTokens('clinic-y', 'cp-1').ok, false)  // cp-1 喺 clinic-x 先過 — patient 層鎖緊（MD §2.8 層 1 係 per-patient）
  })
})
