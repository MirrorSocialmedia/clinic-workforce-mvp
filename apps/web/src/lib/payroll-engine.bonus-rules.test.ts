/**
 * ★★★ 勤工獎取消條件三條規則（2026-08-27 [cwm-bonusrules-20260827]）純函數級測試
 * 跑法: npx tsx --test src/lib/payroll-engine.bonus-rules.test.ts
 *
 * 拍板：① 早退併入遲到一齊計 ② 門檻 > 改 >= ③ 逐個員工設（規則喺 PayRule.configJson）
 * 三條獨立規則可同時生效，任何一條命中即取消：
 *   late_single_exceed  單次遲到/早退 ≥ N 分鐘
 *   late_count_exceed   遲到/早退次數 ≥ N 次
 *   late_total_exceed   累計遲到/早退 ≥ N 分鐘
 *
 * 對應 §六/§8.7 修訂版驗收：#1-#7 三條規則邊界、#16 邊界（啱啱踩線）、#24 any_absence 照舊
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAttendanceBonus } from './payroll-engine'

const AMOUNT = 500
type WD = { late: number[]; early?: number[]; absentDays?: number }

/** 直接餵 workData 給純函數 evaluateAttendanceBonus（caller 合併邏輯另見 bonus-makeup test） */
const wd = ({ late, early = [], absentDays }: WD) => ({
  lateRecords: late.map(minutes => ({ minutes })),
  earlyRecords: early.map(minutes => ({ minutes })),
  leaveRecords: [],
  absentDays,
})

const cfg = (cancel_if: Record<string, unknown>) => ({ amount: AMOUNT, cancel_if })

describe('三條規則邊界（>= 門檻）', () => {
  // #1 單次：15 分 ≥ 15 → 命中
  it('#1 單次 15 分，門檻 15 → 取消（>= 踩線）', () => {
    const r = evaluateAttendanceBonus(cfg({ late_single_exceed: 15 }), wd({ late: [15] }))
    assert.equal(r.cancelled, true)
    assert.equal(r.amount, 0)
  })

  // #2 單次：14 分 < 15 → 唔中
  it('#2 單次 14 分，門檻 15 → 照發', () => {
    const r = evaluateAttendanceBonus(cfg({ late_single_exceed: 15 }), wd({ late: [14] }))
    assert.equal(r.cancelled, false)
    assert.equal(r.amount, AMOUNT)
  })

  // #3 次數：5 次 ≥ 5 → 命中
  it('#3 5 次（各 1 分），門檻 5 → 取消（>= 踩線）', () => {
    const r = evaluateAttendanceBonus(cfg({ late_count_exceed: 5 }), wd({ late: [1, 1, 1, 1, 1] }))
    assert.equal(r.cancelled, true)
    assert.equal(r.amount, 0)
  })

  // #4 次數：4 次 < 5 → 唔中
  it('#4 4 次（各 1 分），門檻 5 → 照發', () => {
    const r = evaluateAttendanceBonus(cfg({ late_count_exceed: 5 }), wd({ late: [1, 1, 1, 1] }))
    assert.equal(r.cancelled, false)
    assert.equal(r.amount, AMOUNT)
  })

  // #5 累計：30 分 ≥ 30 → 命中
  it('#5 累計 30 分，門檻 30 → 取消（>= 踩線）', () => {
    const r = evaluateAttendanceBonus(cfg({ late_total_exceed: 30 }), wd({ late: [10, 10, 10] }))
    assert.equal(r.cancelled, true)
    assert.equal(r.amount, 0)
  })

  // #6 累計：27 分 < 30 → 唔中
  it('#6 累計 27 分，門檻 30 → 照發', () => {
    const r = evaluateAttendanceBonus(cfg({ late_total_exceed: 30 }), wd({ late: [10, 9, 8] }))
    assert.equal(r.cancelled, false)
    assert.equal(r.amount, AMOUNT)
  })

  // #16 邊界：啱啱 30 分 → 取消（>= 语义重驗）
  it('#16 累計啱啱 30 分 → 取消', () => {
    const r = evaluateAttendanceBonus(cfg({ late_total_exceed: 30 }), wd({ late: [30] }))
    assert.equal(r.cancelled, true)
    assert.equal(r.amount, 0)
  })

  // #7 reason 文字：要講到邊條規則 + 實際數值
  it('#7 reason 文字講明邊條規則 + 實際數值', () => {
    const a = evaluateAttendanceBonus(cfg({ late_single_exceed: 15 }), wd({ late: [20] }))
    assert.match(a.reason ?? '', /單次遲到\/早退20分鐘 ≥ 15分鐘/)

    const b = evaluateAttendanceBonus(cfg({ late_count_exceed: 5 }), wd({ late: [1, 2, 3, 4, 5] }))
    assert.match(b.reason ?? '', /遲到\/早退5次 ≥ 5次/)

    const c = evaluateAttendanceBonus(cfg({ late_total_exceed: 30 }), wd({ late: [10, 10, 10] }))
    assert.match(c.reason ?? '', /累計遲到\/早退30分鐘 ≥ 30分鐘/)
  })
})

describe('早退併入遲到（拍板①）+ 規則組合', () => {
  it('早退也計入單次規則（只係早退記錄）', () => {
    const r = evaluateAttendanceBonus(cfg({ late_single_exceed: 15 }), wd({ late: [], early: [20] }))
    assert.equal(r.cancelled, true)
    assert.match(r.reason ?? '', /20分鐘 ≥ 15分鐘/)
  })

  it('遲到 + 早退合併計次數同累計', () => {
    // 遲到 2 次 + 早退 3 次 = 5 次 ≥ 5
    const c = evaluateAttendanceBonus(cfg({ late_count_exceed: 5 }), wd({ late: [1, 1], early: [1, 1, 1] }))
    assert.equal(c.cancelled, true)
    // 遲到 20 + 早退 20 = 40 ≥ 30
    const t = evaluateAttendanceBonus(cfg({ late_total_exceed: 30 }), wd({ late: [20], early: [20] }))
    assert.equal(t.cancelled, true)
    assert.match(t.reason ?? '', /40分鐘 ≥ 30分鐘/)
  })

  it('三條規則同時生效：任何一條命中就取消（先 single → count → total 順序回報）', () => {
    // 全部命中 → 回報先命中嘅 single
    const all = evaluateAttendanceBonus(
      cfg({ late_single_exceed: 15, late_count_exceed: 5, late_total_exceed: 30 }),
      wd({ late: [20, 1, 1, 1, 1] }),
    )
    assert.equal(all.cancelled, true)
    assert.match(all.reason ?? '', /單次/)

    // 只 count 命中
    const onlyCount = evaluateAttendanceBonus(
      cfg({ late_single_exceed: 15, late_count_exceed: 5, late_total_exceed: 100 }),
      wd({ late: [1, 1, 1, 1, 1] }),
    )
    assert.equal(onlyCount.cancelled, true)
    assert.match(onlyCount.reason ?? '', /5次 ≥ 5次/)

    // 只 total 命中
    const onlyTotal = evaluateAttendanceBonus(
      cfg({ late_single_exceed: 15, late_count_exceed: 5, late_total_exceed: 30 }),
      wd({ late: [10, 10, 10] }),
    )
    assert.equal(onlyTotal.cancelled, true)
    assert.match(onlyTotal.reason ?? '', /累計/)
  })

  it('無任何遲到/早退記錄 + 規則已設 → 照發（唔會誤取消）', () => {
    const r = evaluateAttendanceBonus(
      cfg({ late_single_exceed: 15, late_count_exceed: 5, late_total_exceed: 30 }),
      wd({ late: [], early: [] }),
    )
    assert.equal(r.cancelled, false)
    assert.equal(r.amount, AMOUNT)
  })

  it('舊 keys（late_minutes_exceed/late_is_cumulative）唔再讀 — 冇 fallback', () => {
    // 只係舊 key 的 config：新引擎唔讀 → 唔會取消（§8.3 前提：migration 會改晒全部行）
    const r = evaluateAttendanceBonus(
      cfg({ late_minutes_exceed: 30, late_is_cumulative: true }) as any,
      wd({ late: [10, 10, 10, 10] }),
    )
    assert.equal(r.cancelled, false)
    assert.equal(r.amount, AMOUNT)
  })
})

describe('既有條件照舊（#24）', () => {
  it('#24 any_absence：缺勤 1 天 → 取消（同新規則獨立）', () => {
    const r = evaluateAttendanceBonus(cfg({ any_absence: true }), wd({ late: [], absentDays: 1 }))
    assert.equal(r.cancelled, true)
    assert.match(r.reason ?? '', /缺勤 1 天/)
  })

  it('any_unplanned_leave：有臨時請假 → 取消', () => {
    const r = evaluateAttendanceBonus(cfg({ any_unplanned_leave: true }), {
      lateRecords: [],
      earlyRecords: [],
      leaveRecords: [{ isPlanned: false }],
    })
    assert.equal(r.cancelled, true)
    assert.match(r.reason ?? '', /臨時請假/)
  })

  it('cancelsBonus leave（例：喪假）→ 取消', () => {
    const r = evaluateAttendanceBonus(cfg({}), {
      lateRecords: [],
      earlyRecords: [],
      leaveRecords: [{ isPlanned: true, cancelsBonus: true, name: '喪假' }],
    })
    assert.equal(r.cancelled, true)
    assert.match(r.reason ?? '', /喪假/)
  })
})
