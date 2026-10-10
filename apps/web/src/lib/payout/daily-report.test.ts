/**
 * ★ cwm-dailyrev-20261003：每日大數 — 純函數口徑（同醫生月結 Excel A 區 / engine 一致）
 * 跑法: TZ=UTC npx tsx --test src/lib/payout/daily-report.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { aggregateDaily, methodsOf, dayLabel, daysBetween, CLINIC_ROW_KEY, CLINIC_ROW_LABEL, sortDoctorRows, missingCommissionOf, dayStoreTotalsOf, type DailyAlloc, type DailyReport } from './daily-report'
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
    // ★ cwm-dailyv3-20261010 §2：冇重複 colKey → 淨方法名（灰色已代表唔計）
    assert.deepEqual(ms.map(m => m.label), ['Cash', 'Visa', 'Credit', 'Free SP'])
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
  it('⑤ byMethodNet/storeNet：storeNet = B 區收入淨額合計（只計營收方式時同口徑）', () => {
    const { rows, totals } = aggregateDaily(
      [A({ method: 'CASH', amount: 1000, net: 980 }), A({ method: 'VISA', amount: 2000, net: 1960 })],
      [{ key: '2026-09-22', label: '22/09（二）' }],
      () => '2026-09-22', () => 40, () => 0,
    )
    assert.equal(totals.storeTotal, 3000)
    assert.equal(totals.storeNet, 2940)
    assert.equal(totals.doctorNet, 2940) // ★ 同 B 區收入淨額合計同一口徑
    assert.equal(rows[0].byMethodNet['CASH|1|1'], 980)
    assert.equal(rows[0].byMethodNet['VISA|1|1'], 1960)
    assert.equal(rows[0].storeNet, 2940)
  })

  it('⑤ storeNet 唔計 Free SP（只係醫生收入唔係店舖營收），B 區淨額會計', () => {
    const { totals } = aggregateDaily(
      [A({ method: 'CASH', amount: 1000, net: 980 }), A({ method: 'FREE_SP', amount: 300, net: 300, countAsIncome: false })],
      [], () => 'g1', () => 40, () => 0,
    )
    assert.equal(totals.storeNet, 980)
    assert.equal(totals.doctorNet, 1280)
  })

  it('⑤ 不計營收欄（Credit）：byMethodNet 有數但唔入 storeNet', () => {
    const { totals } = aggregateDaily(
      [A({ method: 'CASH', amount: 1000, net: 980 }), A({ method: 'CREDIT', amount: 500, net: 500, countAsIncome: false })],
      [], () => 'g1', () => 40, () => 0,
    )
    assert.equal(totals.byMethodNet['CREDIT|0|0'], 500)
    assert.equal(totals.storeNet, 980)
  })
})

describe('★ cwm-dailyv3-20261010 §1/§2：Clinic 雜項行＋欄名', () => {
  // 同 loadDailyReport byDoctor 嘅 groupOf：isClinic → __clinic__ 行，其餘跟醫生
  const groupDoctor = (a: DailyAlloc): string | null => (a.isClinic ? CLINIC_ROW_KEY : a.providerExtId)

  it('§6.1 雜項行：同醫生 Cash 共用同一 colKey；storeTotal 含雜項；doctorRaw=0、share=null；missingCommission 唔列', () => {
    const allocs = [
      A({ method: 'CASH', amount: 4410, net: 4410, providerExtId: 'p1' }),
      A({ method: 'CASH', amount: 120, net: 120, providerExtId: 'tw-clinic-001', isClinic: true }),
    ]
    const { methods, rows, totals } = aggregateDaily(
      allocs,
      // 同 loadDailyReport byDoctor：rowsInit 帶好 label（含雜項行）
      [{ key: 'p1', label: 'P1' }, { key: CLINIC_ROW_KEY, label: CLINIC_ROW_LABEL }],
      groupDoctor, () => 40, () => 0,
    )
    // 同一 colKey 只有一欄 Cash（唔會自己開多一欄）
    assert.deepEqual(methods.map(m => m.key), ['CASH|1|1'])
    const clinic = rows.find(r => r.key === CLINIC_ROW_KEY)!
    assert.ok(clinic)
    assert.equal(clinic.label, CLINIC_ROW_LABEL)
    assert.equal(clinic.byMethod['CASH|1|1'], 120)
    assert.equal(clinic.storeTotal, 120)
    assert.equal(clinic.storeNet, 120)
    assert.equal(clinic.doctorRaw, 0)
    assert.equal(clinic.share, null) // B 區唔出呢行
    assert.equal(totals.storeTotal, 4530) // 4410 + 120
    assert.equal(totals.byMethod['CASH|1|1'], 4530)
    assert.equal(totals.doctorRaw, 4410) // 醫生收入唔含雜項
    assert.equal(totals.share, 1764) // 4410 × 40%
    assert.deepEqual(missingCommissionOf(rows), []) // 雜項行 doctorRaw=0 唔會列
  })

  it('§6.1b 雜項行可以冇拆帳醫生同行：misc share=null 但 missingCommission 只列真醫生', () => {
    const allocs = [
      A({ method: 'CASH', amount: 100, providerExtId: 'p1' }), // p1 冇拆帳
      A({ method: 'CASH', amount: 50, providerExtId: 'tw-clinic-001', isClinic: true }),
    ]
    const { rows } = aggregateDaily(allocs, [], groupDoctor, () => null, () => 0)
    assert.deepEqual(missingCommissionOf(rows), ['p1'])
  })

  it('§6.2 排序：雜項行排所有醫生之後（唔參與 storeTotal 排序；loadDailyReport byDoctor 先 sort）', () => {
    // sortDoctorRows 純函數直測（雜項 storeTotal 最大都要最後）
    assert.deepEqual(sortDoctorRows([
      { key: CLINIC_ROW_KEY, label: CLINIC_ROW_LABEL, storeTotal: 999 } as any,
      { key: 'p1', label: 'P1', storeTotal: 500 } as any,
      { key: 'p2', label: 'P2', storeTotal: 100 } as any,
    ]).map(r => r.key), ['p1', 'p2', CLINIC_ROW_KEY])
    // 無雜項行：照樣按 storeTotal 排
    assert.deepEqual(sortDoctorRows([
      { key: 'p2', label: 'P2', storeTotal: 100 } as any,
      { key: 'p1', label: 'P1', storeTotal: 500 } as any,
    ]).map(r => r.key), ['p1', 'p2'])
  })

  it('§6.3 欄名：單一 colKey CREDIT → 「Credit」冇括號；同一方法兩 colKey 先有', () => {
    const single = methodsOf([A({ method: 'CREDIT', amount: 500, countAsIncome: false })])
    assert.deepEqual(single.map(m => [m.key, m.label]), [['CREDIT|0|0', 'Credit']])
    const dup = methodsOf([
      A({ method: 'CREDIT', amount: 500, countAsIncome: true }), // CREDIT|1|1
      A({ method: 'CREDIT', amount: 300, countAsIncome: false }), // CREDIT|0|0 → 不計醫生收入
    ])
    assert.deepEqual(dup.map(m => [m.key, m.label]), [
      ['CREDIT|1|1', 'Credit'],
      ['CREDIT|0|0', 'Credit（不計醫生收入）'],
    ])
  })

  it('§6.4 dayStoreTotalsOf 包含雜項（groupOf 有行 + countAsIncome）', () => {
    const allocs = [
      A({ method: 'CASH', amount: 1000, paidAt: at('2026-10-09') }),
      A({ method: 'CASH', amount: 120, paidAt: at('2026-10-09'), providerExtId: 'tw-clinic-001', isClinic: true }),
      A({ method: 'CREDIT', amount: 500, paidAt: at('2026-10-09'), countAsIncome: false }), // 唔計店舖營收
    ]
    const out = dayStoreTotalsOf(allocs, ['2026-10-08', '2026-10-09', '2026-10-10'], groupDoctor)
    assert.deepEqual(out, { '2026-10-08': 0, '2026-10-09': 1120, '2026-10-10': 0 }) // 1000 + 120（Credit 唔計）
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
    // 行 3 = A 標題、4 = header、5 = 22/09、6 = Total、7 = 手續費、8 = 淨額（★ cwm-dailyv2 ⑤）；欄 B=Cash C=Credit D=TOTAL
    assert.equal(ws.getCell(4, 4).value, 'TOTAL')
    assert.deepEqual(ws.getCell(5, 4).value, { formula: 'SUM(B5)', result: 1000 })
    assert.deepEqual(ws.getCell(6, 4).value, { formula: 'SUM(D5:D5)', result: 1000 })
    // ⑤ 手續費行 = Total − 淨額（公式；result 雙寫 — ExcelJS read path 會撳 falsy result，
    //    XML 實證有 <v>0</v>，所以 formula 斷言 + 唔要求 result 字段）
    assert.equal(ws.getCell(7, 1).value, '手續費')
    assert.equal((ws.getCell(7, 2).value as any).formula, 'B6-B8')
    assert.equal((ws.getCell(7, 4).value as any).formula, 'D6-D8')
    // ⑤ 淨額行：黑粗靜態數；TOTAL = SUM 計營收欄
    assert.equal(ws.getCell(8, 1).value, '已扣手續費（淨額）')
    assert.equal(ws.getCell(8, 2).value, 1000)
    assert.deepEqual(ws.getCell(8, 4).value, { formula: 'SUM(B8)', result: 1000 })
    // B 區：行 10 標題、11 header、12 data、13 Total；E = 分成
    assert.equal(ws.getCell(12, 5).value, 400)
    assert.deepEqual(ws.getCell(13, 5).value, { formula: 'SUM(E12:E12)', result: 400 })
  })
})
