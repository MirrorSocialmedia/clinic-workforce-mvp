/**
 * ★ cwm-dailyrev-20261003：每日大數 — 純函數口徑（同醫生月結 Excel A 區 / engine 一致）
 * 跑法: TZ=UTC npx tsx --test src/lib/payout/daily-report.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { aggregateDaily, methodsOf, dayLabel, daysBetween, type DailyAlloc, type DailyReport } from './daily-report'
import { buildDailySheet } from './xlsx-report'

const at = (d: string, hh = '10') => new Date(`${d}T${hh}:00:00+08:00`)
const A = (o: Partial<DailyAlloc> & { method: string; amount: number }): DailyAlloc => ({
  net: o.amount, countAsIncome: true, paidAt: at('2026-09-22'), providerExtId: 'p1', clinicExtId: 'c1', ...o,
})

describe('methodsOf', () => {
  it('次序跟 METHOD_ORDER；Credit／Free SP label 同 Excel 一樣', () => {
    const ms = methodsOf([
      A({ method: 'VISA', amount: 1 }),
      A({ method: 'CREDIT', amount: 1, countAsIncome: false }),
      A({ method: 'CASH', amount: 1 }),
      A({ method: 'FREE_SP', amount: 1, countAsIncome: false }),
    ])
    assert.deepEqual(ms.map(m => m.label), ['Cash', 'Visa', 'Credit（不計醫生收入）', 'Free SP（不計店舖營收）'])
    assert.deepEqual(ms.map(m => [m.storeIncome, m.doctorIncome]), [[true, true], [true, true], [false, false], [false, true]])
  })
})

describe('aggregateDaily', () => {
  const allocs = [
    A({ method: 'CASH', amount: 1000, net: 1000, paidAt: at('2026-09-22') }),
    A({ method: 'VISA', amount: 2000, net: 1960, paidAt: at('2026-09-22', '23') }), // HK 23:00 仍屬 22 號
    A({ method: 'CREDIT', amount: 500, net: 500, countAsIncome: false, paidAt: at('2026-09-22') }),
    A({ method: 'FREE_SP', amount: 300, net: 300, countAsIncome: false, paidAt: at('2026-09-23') }),
  ]
  const hkDay = (a: DailyAlloc) => new Date(a.paidAt.getTime() + 8 * 3600e3).toISOString().slice(0, 10)

  it('逐日：冇收款嘅日照出；TOTAL 只計店舖營收；醫生收入計 Free SP 唔計 Credit', () => {
    const { rows, totals } = aggregateDaily(
      allocs,
      daysBetween('2026-09-21', '2026-09-23').map(d => ({ key: d, label: dayLabel(d) })),
      hkDay, () => 40, k => (k === '2026-09-22' ? 2 : 0),
    )
    assert.deepEqual(rows.map(r => r.key), ['2026-09-21', '2026-09-22', '2026-09-23'])
    assert.equal(rows[0].storeTotal, 0)
    const d22 = rows[1]
    assert.equal(d22.label, '22/09（二）')
    assert.equal(d22.storeTotal, 3000)
    assert.equal(d22.doctorRaw, 3000)
    assert.equal(d22.doctorNet, 2960)
    assert.equal(d22.share, 1184) // 2960 × 40%
    assert.equal(d22.spCount, 2)
    assert.equal(rows[2].storeTotal, 0)
    assert.equal(rows[2].doctorRaw, 300)
    assert.equal(totals.storeTotal, 3000)
    assert.equal(totals.doctorNet, 3260)
    assert.equal(totals.share, 1304)
    assert.equal(totals.byMethod['CREDIT|0|0'], 500)
  })

  it('逐醫生：冇拆帳 → 該行 share=null，合計只加有設定嗰啲；groupOf=null 唔入', () => {
    const mixed = [
      A({ method: 'CASH', amount: 1000, providerExtId: 'p1' }),
      A({ method: 'CASH', amount: 600, providerExtId: 'p2' }),
      A({ method: 'CASH', amount: 999, providerExtId: 'clinic' }),
    ]
    const { rows, totals } = aggregateDaily(
      mixed, [],
      a => (a.providerExtId === 'clinic' ? null : a.providerExtId),
      a => (a.providerExtId === 'p1' ? 50 : null),
      () => 0,
    )
    assert.deepEqual(rows.map(r => [r.key, r.storeTotal, r.share]), [['p1', 1000, 500], ['p2', 600, null]])
    assert.equal(totals.storeTotal, 1600)
    assert.equal(totals.share, 500)
  })
})

describe('buildDailySheet', () => {
  it('A 區 TOTAL 公式 + result 雙寫；B 區分成合計黃底', () => {
    const agg = aggregateDaily(
      [A({ method: 'CASH', amount: 1000 }), A({ method: 'CREDIT', amount: 200, countAsIncome: false })],
      [{ key: '2026-09-22', label: dayLabel('2026-09-22') }],
      () => '2026-09-22', () => 40, () => 0,
    )
    const report: DailyReport = { mode: 'byDay', from: '2026-09-22', to: '2026-09-22', title: '王醫生 · 旺角 · 2026-09-22（二）', ...agg, missingCommission: [], percent: 40 }
    const wb = new ExcelJS.Workbook()
    const ws = buildDailySheet(wb, report)
    // 行 3 = A 標題、4 = header、5 = 22/09、6 = Total；欄 B=Cash C=Credit D=TOTAL
    assert.equal(ws.getCell(4, 4).value, 'TOTAL')
    assert.deepEqual(ws.getCell(5, 4).value, { formula: 'SUM(B5)', result: 1000 })
    assert.deepEqual(ws.getCell(6, 4).value, { formula: 'SUM(D5:D5)', result: 1000 })
    // B 區：行 8 標題、9 header、10 data、11 Total；E = 分成
    assert.equal(ws.getCell(10, 5).value, 400)
    assert.deepEqual(ws.getCell(11, 5).value, { formula: 'SUM(E10:E10)', result: 400 })
  })
})
