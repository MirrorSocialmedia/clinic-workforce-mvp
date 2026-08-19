/**
 * ★★★ 時薪 eoWage 回歸測試（2026-08-19）
 * 跑法: TZ=UTC npx tsx --test src/lib/payroll-engine.hourly-eowage.test.ts
 * （Node 22 內建 test runner，唔加新 dependency，同 parsePaymentReport.test.ts 一致）
 *
 * 背景：calculateSimpleHourlyPay 之前 detail 冇寫 eoWage / excludedDays / excludedWage，
 *   而 lib/adw.ts:300 用 `d.eoWage === undefined` 判斷「引擎有冇計過」→
 *   任何含時薪員工嘅計糧單永遠 finalize 唔到（生產阻塞）。
 *
 * 本測試用 fake prisma delegate（唔真連 DB）斷言：
 *   1. detail.eoWage === totalPay（=== totalPayable）—— 時薪無 storeBonus，EO 工資 = 實付
 *   2. detail.excludedDays / excludedWage === 0
 *   3. adw.ts:300 嘅 `eoWage === undefined` 過濾對時薪 detail 必須 0 命中
 *
 * 註：月薪路徑 eoWage（finalGrossPay − NON_EO_WAGE 寫入 detail）完全冇改動，
 *   零回歸證據 = git diff 顯示該寫入點未郁 + test-payroll.ts（如需跑本地 DB）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from './prisma'
import { calculatePayrollWithRules } from './payroll-engine'

// ---- fake 數據 -----------------------------------------------------------
// 2026-08、時薪 $92、lunch_break 開啟（default 60 分 / min 30 分）
const EMP = 'emp-hourly-test'
const RATE = 92

/** 01:00 UTC = 09:00 HKT —— 避開跨日邊界，時區確定性由 toHKDateStr（Intl HK）保證 */
const P = (day: number, h: number, m = 0): string =>
  new Date(Date.UTC(2026, 7, day, h, m)).toISOString()

const PUNCHES = [
  // Day 1 08-03: 09:00 IN → 12:00 LS → 13:00 LE → 18:00 OUT
  //   span 540 min − 60 lunch = 480 min = 8h × $92 = $736
  { id: 'p1', punchType: 'CLOCK_IN', clinicId: 'c1', punchTime: P(3, 1), void: null },
  { id: 'p2', punchType: 'LUNCH_START', clinicId: 'c1', punchTime: P(3, 4), void: null },
  { id: 'p3', punchType: 'LUNCH_END', clinicId: 'c1', punchTime: P(3, 5), void: null },
  { id: 'p4', punchType: 'CLOCK_OUT', clinicId: 'c1', punchTime: P(3, 10), void: null },
  // Day 2 08-04: 10:00 IN → 14:00 OUT，冇 LS/LE 卡 → 扣 default 60
  //   span 240 min − 60 lunch = 180 min = 3h × $92 = $276
  { id: 'p5', punchType: 'CLOCK_IN', clinicId: 'c1', punchTime: P(4, 2), void: null },
  { id: 'p6', punchType: 'CLOCK_OUT', clinicId: 'c1', punchTime: P(4, 6), void: null },
  // Day 3 08-05: 只 IN 無 OUT、無更次 → 不計薪 0 min
  { id: 'p7', punchType: 'CLOCK_IN', clinicId: 'c1', punchTime: P(5, 2), void: null },
]

const CONFIG: any = {
  base_type: 'hourly',
  hourly_rate: RATE,
  modifiers: {
    lunch_break: { enabled: true, defaultMinutes: 60, minMinutes: 30 },
  },
}

// ---- patch prisma delegate（唔真連 DB）------------------------------------
type Any = any
const saved: Record<string, Any> = {}
const fakes: Record<string, Any> = {
  // 無更次 → 全走 noShift 路徑（打卡照計薪）
  shift: { findMany: async () => [] },
  punchRecord: { findMany: async () => PUNCHES },
  punchCorrection: { findMany: async () => [] },
}

before(() => {
  for (const k of Object.keys(fakes)) {
    saved[k] = (prisma as Any)[k]
    // 實例層 defineProperty 陰掉 prisma 類 prototype 上嘅 model getter
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})

after(() => {
  for (const k of Object.keys(saved)) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
})

describe('時薪 eoWage（adw.ts:300 finalize 阻塞修復）', () => {
  it('detail.eoWage === totalPay（=== totalPayable）', async () => {
    const r = await calculatePayrollWithRules(EMP, new Date(Date.UTC(2026, 7, 15)), null, CONFIG)
    const d = r.detail as any
    // 480 min @ $92 = $736 + 180 min @ $92 = $276 → totalPay $1012
    assert.equal(r.totalPayable, 1012)
    assert.equal(r.workedHours, 11)
    assert.equal(typeof d.eoWage, 'number', 'eoWage 必須係 number（adw.ts:300 用 === undefined 判斷）')
    assert.equal(d.eoWage, r.totalPayable, 'eoWage 必須等於 totalPay（時薪無 storeBonus）')
    assert.equal(d.eoWage, 1012)
    // 模擬 adw.ts:300 嘅 notComputed 過濾
    const notComputed = [d].filter((x: any) => x.eoWage === undefined)
    assert.equal(notComputed.length, 0, '時薪 detail 唔可以被判「未計算」')
  })

  it('detail.excludedDays / excludedWage === 0', async () => {
    const r = await calculatePayrollWithRules(EMP, new Date(Date.UTC(2026, 7, 15)), null, CONFIG)
    const d = r.detail as any
    assert.equal(d.excludedDays, 0)
    assert.equal(d.excludedWage, 0)
  })

  it('totalMinutes / days 明細一致（行為未改，只加欄）', async () => {
    const r = await calculatePayrollWithRules(EMP, new Date(Date.UTC(2026, 7, 15)), null, CONFIG)
    const d = r.detail as any
    assert.equal(d.payType, 'HOURLY')
    assert.equal(d.totalMinutes, 660)
    assert.equal(d.days.length, 3)
    assert.equal(d.days[0].minutes, 480)
    assert.equal(d.days[0].amount, 736)
    assert.equal(d.days[1].minutes, 180)
    assert.equal(d.days[1].amount, 276)
    assert.equal(d.days[2].minutes, 0)
  })
})
