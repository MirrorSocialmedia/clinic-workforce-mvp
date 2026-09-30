/**
 * ★ 2026-09-30 [cwm-rosterjoin]：底薪明細（月中入職／離職）
 * 跑法: TZ=UTC npx tsx --test src/lib/base-pay-breakdown.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describeBasePay } from './base-pay-breakdown'

describe('describeBasePay', () => {
  it('9/8 入職、月薪 $14,000 → 23/30 日 = $10,733.33（對得上糧單）', () => {
    const r = describeBasePay({ basePay: 10733.33, monthlySalary: 14000, periodMonth: '2026-09', joinDate: '2026-09-08T00:00:00+08:00' })!
    assert.equal(r.employedDays, 23)
    assert.equal(r.monthDays, 30)
    assert.equal(r.from, '2026-09-08')
    assert.equal(r.to, '2026-09-30')
    assert.equal(r.computed, 10733.33)
    assert.equal(r.matches, true)
    assert.equal(r.full, false)
  })

  it('新 run 讀 employedRatioDetail（優先過入職日推算）', () => {
    const r = describeBasePay({
      basePay: 10733.33, monthlySalary: 14000, periodMonth: '2026-09',
      ratioDetail: { numerator: 23, denominator: 30, from: '2026-09-08', to: '2026-09-30' }, joinDate: '2020-01-01',
    })!
    assert.equal(r.from, '2026-09-08')
    assert.equal(r.employedDays, 23)
  })

  it('月中離職：resignedAt = 最後工作日翌日（9/16）→ 受僱 9/1–9/15 = 15 日', () => {
    const r = describeBasePay({ basePay: 7000, monthlySalary: 14000, periodMonth: '2026-09', joinDate: '2020-01-01', resignedAt: '2026-09-16T00:00:00+08:00' })!
    assert.equal(r.to, '2026-09-15')
    assert.equal(r.employedDays, 15)
    assert.equal(r.computed, 7000)
  })

  it('全月受僱 → full，底薪 = 月薪', () => {
    const r = describeBasePay({ basePay: 14000, monthlySalary: 14000, periodMonth: '2026-09', joinDate: '2020-01-01' })!
    assert.equal(r.full, true)
    assert.equal(r.computed, 14000)
  })

  it('對唔上（例如月中調薪）→ matches false；冇月薪 → null', () => {
    const r = describeBasePay({ basePay: 12000, monthlySalary: 14000, periodMonth: '2026-09', joinDate: '2026-09-08' })!
    assert.equal(r.matches, false)
    assert.equal(describeBasePay({ basePay: 1, monthlySalary: 0, periodMonth: '2026-09' }), null)
  })
})
