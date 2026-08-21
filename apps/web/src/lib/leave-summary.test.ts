/**
 * ★ 月視圖假期總覽 helpers 測試（2026-08-21，cw-plmemo-20260821-a1 §3）
 * 跑法: npx tsx --test src/lib/leave-summary.test.ts
 *
 * 覆蓋 MD §4 驗收：
 *   - #21 年假區間由 joinDate 推服務年度（唔係曆年）
 *   - #22 週年當日切換新年度
 *   - #23/#24/#25 應得 = PayRule table（法定底 / 自訂取大）
 *   - §6.1（2026-08-22）應得 = 全年額表查詢、唔再 prorata：#35 #36
 *   - #27 連續兩日年假（兩張申請）合併顯示
 *   - #19/#20 R/PL/R+PL 相加、PL 係 R 子集
 *   - 鐵律 6：2 月 29 日入職非閏年週年 roll 去 3/1
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  serviceYearRange,
  overlapsRange,
  formatTakenDates,
  aggregateRestPl,
  entitledForServiceYear,
} from './leave-summary'
import { resolveLeaveTable, STATUTORY_LEAVE_TABLE } from './leave-calculation'

const D = (s: string) => new Date(`${s}T00:00:00+08:00`)

describe('serviceYearRange（服務年度區間）', () => {
  it('未到今年週年 → 上一個服務年度（#21：由 joinDate 推，唔係曆年）', () => {
    // 2025-09-01 入職，2026-08-21 未到 9/1 週年
    const r = serviceYearRange(D('2025-09-01'), D('2026-08-21'))
    assert.deepEqual(r, { start: '2025-09-01', end: '2026-08-31', index: 0 })
  })

  it('週年當日 → 切換到新年度（#22）', () => {
    const r = serviceYearRange(D('2025-09-01'), D('2026-09-01'))
    assert.deepEqual(r, { start: '2026-09-01', end: '2027-08-31', index: 1 })
  })

  it('週年過一日 → 新年度', () => {
    const r = serviceYearRange(D('2025-09-01'), D('2026-09-02'))
    assert.deepEqual(r, { start: '2026-09-01', end: '2027-08-31', index: 1 })
  })

  it('隔年入職（第 3 個服務年度，index 2）', () => {
    const r = serviceYearRange(D('2024-01-15'), D('2026-08-21'))
    assert.deepEqual(r, { start: '2026-01-15', end: '2027-01-14', index: 2 })
  })

  it('2/29 入職：非閏年週年 roll 去 3/1（鐵律 6，實測）', () => {
    // 2024-02-29（閏年）入職；2026 非閏年 → 週年 = 2026-03-01
    const r = serviceYearRange(D('2024-02-29'), D('2026-08-21'))
    assert.deepEqual(r, { start: '2026-03-01', end: '2027-02-28', index: 2 })
    // 未到 roll 後週年（2026-02-28）→ 仍係上一個服務年度
    const r2 = serviceYearRange(D('2024-02-29'), D('2026-02-28'))
    assert.deepEqual(r2, { start: '2025-03-01', end: '2026-02-28', index: 1 })
    // roll 後週年當日（2026-03-01）→ 新年度
    const r3 = serviceYearRange(D('2024-02-29'), D('2026-03-01'))
    assert.deepEqual(r3, { start: '2026-03-01', end: '2027-02-28', index: 2 })
  })
})

describe('entitledForServiceYear（應得年假）—— ★ 2026-08-22 §6.1：全年額表查詢（唔再 prorata）', () => {
  it('index 0 → 法定第 1 格 7（法定底，#24）', () => {
    assert.equal(entitledForServiceYear(0), STATUTORY_LEAVE_TABLE[0])
  })

  it('#35 Ceci（2025-10-01 入職），index=0 → 應得 7 全額（唔係 6.x）', () => {
    // §6.1 前用 leaveForServiceYear 會出 7 × 325/365 ≈ 6.23（實測「6.2 天」）
    const asOf = D('2026-08-21')
    const sy = serviceYearRange(D('2025-10-01'), asOf)
    assert.equal(sy.index, 0)
    assert.equal(entitledForServiceYear(sy.index), 7)
  })

  it('#36 payRule 自訂 table 第一格 6（低過法定）→ 仍然 7（resolveLeaveTable 取大）', () => {
    const table = resolveLeaveTable([6, 7, 8, 9, 10, 11, 12, 13, 14])
    assert.equal(table[0], 7) // resolveLeaveTable 內部 Math.max(自訂, 法定)
    assert.equal(entitledForServiceYear(0, table), 7)
  })

  it('自訂 table 高過法定 → 用自訂（#23）', () => {
    assert.equal(entitledForServiceYear(0, [8, 9, 10]), 8)
  })

  it('9 年+ → 最後一格（index 夾死喺 8）', () => {
    assert.equal(entitledForServiceYear(8), STATUTORY_LEAVE_TABLE[8])
    assert.equal(entitledForServiceYear(12), STATUTORY_LEAVE_TABLE[8])
  })

  it('2/29 入職 → 無日期計算、唔係 NaN（舊 fallback 已移除）', () => {
    // 2024-02-29 入職，2026-08-21 → index 2 → 全年額 8
    const sy = serviceYearRange(D('2024-02-29'), D('2026-08-21'))
    assert.equal(sy.index, 2)
    assert.equal(entitledForServiceYear(sy.index), STATUTORY_LEAVE_TABLE[2])
  })
})

describe('formatTakenDates（連續日合併）', () => {
  it('兩張獨立一日申請 8/20、8/21 → 合併 8/20–8/21（#27）', () => {
    const t = [
      { startDate: D('2026-08-20'), endDate: D('2026-08-20') },
      { startDate: D('2026-08-21'), endDate: D('2026-08-21') },
    ]
    assert.equal(formatTakenDates(t), '8/20–8/21')
  })

  it('唔連續 → 分項', () => {
    const t = [
      { startDate: D('2026-08-20'), endDate: D('2026-08-20') },
      { startDate: D('2026-08-21'), endDate: D('2026-08-21') },
      { startDate: D('2026-08-23'), endDate: D('2026-08-23') },
    ]
    assert.equal(formatTakenDates(t), '8/20–8/21、8/23')
  })

  it('單張多日申請 → 一段', () => {
    const t = [{ startDate: D('2026-06-08'), endDate: D('2026-06-09') }]
    assert.equal(formatTakenDates(t), '6/8–6/9')
  })

  it('重疊申請去重（同一日唔雙重計）', () => {
    const t = [
      { startDate: D('2026-08-20'), endDate: D('2026-08-21') },
      { startDate: D('2026-08-21'), endDate: D('2026-08-22') },
    ]
    assert.equal(formatTakenDates(t), '8/20–8/22')
  })

  it('空 → 空字串', () => {
    assert.equal(formatTakenDates([]), '')
  })
})

describe('aggregateRestPl（R/PL 聚合）', () => {
  it('8 R + 2 PL = 10（#19），R + PL = total（#20），PL 係 R 子集（拍板②a）', () => {
    const mk = (date: string, pl = false, type = 'REST_DAY') => ({
      employeeId: 'e1',
      startDate: D(date),
      endDate: D(date),
      isEmployeeRequested: pl,
      leaveType: { systemKey: type },
    })
    const reqs = [
      mk('2026-08-01'), mk('2026-08-02'), mk('2026-08-08'), mk('2026-08-09'),
      mk('2026-08-15'), mk('2026-08-16'), mk('2026-08-22'), mk('2026-08-23'),
      mk('2026-08-29', true), mk('2026-08-30', true),
      mk('2026-08-10', false, 'SICK'), // 非 REST_DAY → 唔計
    ]
    const r = aggregateRestPl(reqs, '2026-08-01', '2026-08-31')
    assert.deepEqual(r.e1, { restOnly: 8, pl: 2, total: 10 })
    assert.equal(r.e1.restOnly + r.e1.pl, r.e1.total)
  })

  it('跨月邊界 clip 到本月（範圍查詢會攞返 7/31–8/1）', () => {
    const reqs = [{
      employeeId: 'e1',
      startDate: D('2026-07-31'),
      endDate: D('2026-08-01'),
      isEmployeeRequested: false,
      leaveType: { systemKey: 'REST_DAY' },
    }]
    const r = aggregateRestPl(reqs, '2026-08-01', '2026-08-31')
    assert.deepEqual(r.e1, { restOnly: 1, pl: 0, total: 1 })
  })

  it('同一日重複申請去重', () => {
    const mk = (date: string) => ({
      employeeId: 'e1', startDate: D(date), endDate: D(date),
      isEmployeeRequested: false, leaveType: { systemKey: 'REST_DAY' },
    })
    const r = aggregateRestPl([mk('2026-08-01'), mk('2026-08-01')], '2026-08-01', '2026-08-31')
    assert.deepEqual(r.e1, { restOnly: 1, pl: 0, total: 1 })
  })

  it('多員工分開計', () => {
    const mk = (emp: string, date: string, pl = false) => ({
      employeeId: emp, startDate: D(date), endDate: D(date),
      isEmployeeRequested: pl, leaveType: { systemKey: 'REST_DAY' },
    })
    const r = aggregateRestPl([mk('e1', '2026-08-01'), mk('e2', '2026-08-01', true)], '2026-08-01', '2026-08-31')
    assert.deepEqual(r.e1, { restOnly: 1, pl: 0, total: 1 })
    assert.deepEqual(r.e2, { restOnly: 0, pl: 1, total: 1 })
  })
})

describe('overlapsRange（服務年度重疊判斷）', () => {
  it('完全喺範圍內', () => {
    assert.ok(overlapsRange({ startDate: D('2026-08-15'), endDate: D('2026-08-20') }, '2026-08-01', '2026-08-31'))
  })
  it('範圍外 → 唔計', () => {
    assert.ok(!overlapsRange({ startDate: D('2026-09-01'), endDate: D('2026-09-05') }, '2026-08-01', '2026-08-31'))
  })
  it('端點相切 → 算重疊', () => {
    assert.ok(overlapsRange({ startDate: D('2026-08-30'), endDate: D('2026-09-05') }, '2026-08-01', '2026-08-30'))
    assert.ok(overlapsRange({ startDate: D('2026-07-25'), endDate: D('2026-08-01') }, '2026-08-01', '2026-08-31'))
  })
  it('跨年度假期（橫跨兩邊）→ 算重疊', () => {
    assert.ok(overlapsRange({ startDate: D('2027-03-10'), endDate: D('2027-03-20') }, '2027-03-05', '2027-03-14'))
  })
})
