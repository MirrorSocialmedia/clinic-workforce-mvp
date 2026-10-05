// ★ cwm-reconclinic-20261006：全店月報（逐行 Practitioner）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { parsePaymentReport } from './parsePaymentReport'
import { groupByPractitioner, pickSuggestion, normName, BLANK_PRACTITIONER } from './clinic-report'

function buildBuf(rows: any[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Payment Report')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

// 同老闆張全店報表一樣嘅格式：頂部 Clinic／Month（A 欄標籤、B 欄值），冇 Practitioner
const CLINIC_REPORT = [
  ['Payment Report'],
  ['Clinic:', 'TW'],
  ['Month:', '2026-09'],
  ['Date', 'Transaction Code', 'Patient Code', 'Patient Name', 'Practitioner', 'Payment Method', 'Voucher No.', 'Total Charges', 'Total Paid', 'Visit Reason', 'Remarks'],
  ['2026-09-01', '202605190007', 'TW007507', 'X', 'Dr. Tse Tak Fai, Dennis', 'MASTER', '', '19,500.00', '6,000.00', 'PAIN', ''],
  ['2026-09-01', '202609010001', 'TW007989', 'X', 'Dr. Tse Tak Fai, Dennis', 'HCV', '', '580.00', '580.00', 'SP', ''],
  ['2026-09-02', '202608050038', 'TW007842', 'X', 'Dr. Ho Ka Chun', 'CREDIT', '', '2,000.00', '2,000.00', '', ''],
  [null, '202608050038', 'TW007842', 'X', '', 'VISA', '', '0.00', '1,000.00', '', ''], // 拆分行：Practitioner 空 → 承接
  ['2026-09-03', '202609030001', 'TW000001', 'X', '', 'CASH', '', '100.00', '100.00', '', ''],      // 冇寫醫生
]

test('全店報表：讀到逐行 Practitioner、拆分行承接、頂部冇 Practitioner', () => {
  const r = parsePaymentReport(buildBuf(CLINIC_REPORT))
  assert.equal(r.hasPractitionerColumn, true)
  assert.equal(r.meta.practitioner, '')
  assert.equal(r.meta.clinic, 'TW')
  assert.equal(r.meta.month, '2026-09')
  assert.equal(r.rows.length, 5)
  assert.equal(r.rows[3].practitioner, 'Dr. Ho Ka Chun')
  assert.equal(r.rows[3].paid, 1000)
  assert.equal(r.rows[4].practitioner, '')
})

test('groupByPractitioner：按名分組（實收合計）、空白自成一組、大細階空格當同一個名', () => {
  const r = parsePaymentReport(buildBuf(CLINIC_REPORT))
  const groups = groupByPractitioner([...r.rows, { ...r.rows[0], practitioner: '  dr. tse  tak fai, dennis ', paid: 1 }])
  const tse = groups.find(g => g.nameNorm === normName('Dr. Tse Tak Fai, Dennis'))!
  assert.equal(tse.rows.length, 3)
  assert.equal(tse.total, 6581)
  const ho = groups.find(g => g.name === 'Dr. Ho Ka Chun')!
  assert.equal(ho.total, 3000)
  const blank = groups.find(g => g.name === BLANK_PRACTITIONER)!
  assert.equal(blank.total, 100)
  assert.equal(groups.length, 3)
  // 全部行都喺某一組（唔會靜靜跳過）
  assert.equal(groups.reduce((a, g) => a + g.rows.length, 0), 6)
})

test('pickSuggestion：最多票嘅醫生；冇票 → null', () => {
  assert.deepEqual(pickSuggestion(new Map([['A', 3], ['B', 184]]), 186), { providerId: 'B', matched: 184, total: 186 })
  assert.equal(pickSuggestion(new Map(), 12), null)
})

test('單一醫生舊格式：冇 Practitioner 欄 → hasPractitionerColumn false', () => {
  const r = parsePaymentReport(buildBuf([
    ['Practitioner: Dr. Lau (LAU)', 'Clinic: MF', 'Month: 2026-07'], [],
    ['Date', 'Transaction Code', 'Total Charges', 'Total Paid'],
    ['05/07/2026', '1', '10', '10'],
  ]))
  assert.equal(r.hasPractitionerColumn, false)
  assert.equal(r.rows[0].practitioner, '')
})
