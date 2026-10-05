/**
 * ★ 2026-09-30 [cwm-restdebt] F1(d)：超額休息日 = 休息日帳透支 純函數測試（RS-01/02/03/04/14/20）
 * 跑法: TZ=UTC npx tsx --test src/lib/settlement-utils.test.ts
 *
 * 覆蓋工單 F1(d) 六 case：
 *   1. CC2：entitled 19、used 21、grant 4、30/30、$17,000 → excess 2、$1,133.33
 *   2. 冇透支：entitled 19、used 18 → excess 0、$0
 *   3. 月中 9/15 離職：entitled 19（含 9 月 4 日）、used 17、grant 4、15/30 → 應得 17、excess 0
 *   4. 月中 9/15 離職：entitled 19、used 19、grant 4、15/30 → 應得 17、excess 2
 *   5. 當月冇發放：grant 0、15/30 → unearned 0
 *   6. monthDays 0（防呆）→ amount 0
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calcRestDayDebt } from './settlement-utils'

describe('calcRestDayDebt（離職超額休息日 = 休息日帳透支）', () => {
  it('#1 CC2：entitled 19、used 21、grant 4、做足 30 日、$17,000 → excess 2 日、$1,133.33', () => {
    const r = calcRestDayDebt({
      entitledAsOf: 19, usedAsOf: 21,
      monthlyRestGrantDays: 4, employedDays: 30, monthDays: 30, monthlySalary: 17000,
    })
    assert.equal(r.unearnedThisMonth, 0)
    assert.equal(r.entitledRestDays, 19)
    assert.equal(r.usedRestDays, 21)
    assert.equal(r.excessDays, 2)
    assert.equal(r.amount, 1133.33)
  })

  it('#2 冇透支：entitled 19、used 18 → excess 0、$0（唔會變加錢）', () => {
    const r = calcRestDayDebt({
      entitledAsOf: 19, usedAsOf: 18,
      monthlyRestGrantDays: 4, employedDays: 30, monthDays: 30, monthlySalary: 17000,
    })
    assert.equal(r.excessDays, 0)
    assert.equal(r.amount, 0)
  })

  it('#3 月中 9/15 離職：entitled 19（含 9 月 4 日）、used 17、grant 4、15/30 → 應得 17、excess 0', () => {
    const r = calcRestDayDebt({
      entitledAsOf: 19, usedAsOf: 17,
      monthlyRestGrantDays: 4, employedDays: 15, monthDays: 30, monthlySalary: 17000,
    })
    assert.equal(r.unearnedThisMonth, 2)
    assert.equal(r.entitledRestDays, 17)
    assert.equal(r.excessDays, 0)
    assert.equal(r.amount, 0)
  })

  it('#4 月中 9/15 離職：entitled 19、used 19、grant 4、15/30 → 應得 17、excess 2', () => {
    const r = calcRestDayDebt({
      entitledAsOf: 19, usedAsOf: 19,
      monthlyRestGrantDays: 4, employedDays: 15, monthDays: 30, monthlySalary: 17000,
    })
    assert.equal(r.entitledRestDays, 17)
    assert.equal(r.excessDays, 2)
    assert.ok(r.amount > 0)
  })

  it('#5 當月冇發放：grant 0、15/30 → unearned 0（應得唔會被拉低）', () => {
    const r = calcRestDayDebt({
      entitledAsOf: 19, usedAsOf: 17,
      monthlyRestGrantDays: 0, employedDays: 15, monthDays: 30, monthlySalary: 17000,
    })
    assert.equal(r.unearnedThisMonth, 0)
    assert.equal(r.entitledRestDays, 19)
    assert.equal(r.excessDays, 0)
  })

  it('#6 monthDays 0（防呆）→ unearned 0、amount 0', () => {
    const r = calcRestDayDebt({
      entitledAsOf: 19, usedAsOf: 21,
      monthlyRestGrantDays: 4, employedDays: 0, monthDays: 0, monthlySalary: 17000,
    })
    assert.equal(r.unearnedThisMonth, 0)
    assert.equal(r.amount, 0)
  })
})
