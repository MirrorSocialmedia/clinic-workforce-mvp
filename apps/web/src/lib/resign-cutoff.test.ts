/**
 * ★ 2026-09-30 [cwm-restdebt] F2：「已用年假 截至最後工作日」純函數測試（RS-05/06）
 * 跑法: TZ=UTC npx tsx --test src/lib/resign-cutoff.test.ts
 *
 * 覆蓋：
 *   - 完全喺離職之後嘅年假 → 全數剔走
 *   - 跨過離職日嘅年假 → 按曆日比例剔（9/28–10/3 + 9/30 離職 → 剔 3/6）
 *   - 完全喺離職之前 → 0
 *   - 多筆累加
 *   - days ≠ 曆日數（有假日）→ 比例照曆日拆
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { futureAnnualLeaveDays } from './resign-cutoff'

const D = (s: string) => new Date(`${s}T00:00:00+08:00`)

describe('futureAnnualLeaveDays（年假已用「截至最後工作日」剔走部分）', () => {
  it('完全喺離職之後嘅年假（10/5–10/7，lastDay 9/30）→ 全數 3 日剔走', () => {
    const d = futureAnnualLeaveDays(
      [{ startDate: D('2026-10-05'), endDate: D('2026-10-07'), days: 3 }],
      '2026-09-30',
    )
    assert.ok(Math.abs(d - 3) < 1e-9)
  })

  it('跨過離職日嘅年假（9/28–10/3，lastDay 9/30）→ 剔 3/6 = 一半', () => {
    const d = futureAnnualLeaveDays(
      [{ startDate: D('2026-09-28'), endDate: D('2026-10-03'), days: 6 }],
      '2026-09-30',
    )
    assert.ok(Math.abs(d - 3) < 1e-9)
  })

  it('完全喺離職之前嘅年假 → 0', () => {
    const d = futureAnnualLeaveDays(
      [{ startDate: D('2026-09-01'), endDate: D('2026-09-05'), days: 5 }],
      '2026-09-30',
    )
    assert.equal(d, 0)
  })

  it('多筆累加：1 筆日後 + 1 筆跨日 + 1 筆日前', () => {
    const d = futureAnnualLeaveDays(
      [
        { startDate: D('2026-10-05'), endDate: D('2026-10-07'), days: 3 },   // → 3
        { startDate: D('2026-09-28'), endDate: D('2026-10-03'), days: 6 },   // → 3
        { startDate: D('2026-09-01'), endDate: D('2026-09-02'), days: 2 },   // → 0
      ],
      '2026-09-30',
    )
    assert.ok(Math.abs(d - 6) < 1e-9)
  })

  it('days ≠ 曆日數（5 曆日假、4 日假額）→ 比例照曆日拆', () => {
    // 9/28–10/3 = 6 曆日，假額 5 日（期間有一日唔計假額）
    // after = 10/1–10/3 = 3 曆日 → 5 × 3/6 = 2.5
    const d = futureAnnualLeaveDays(
      [{ startDate: D('2026-09-28'), endDate: D('2026-10-03'), days: 5 }],
      '2026-09-30',
    )
    assert.ok(Math.abs(d - 2.5) < 1e-9)
  })

  it('空輸入 → 0', () => {
    assert.equal(futureAnnualLeaveDays([], '2026-09-30'), 0)
  })
})
