import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { parseFilters, summarize, buildRecordsWorkbook, hkDateTime, type ChequeRecord, type RecordFilters } from './records-build'

const rec = (over: Partial<ChequeRecord>): ChequeRecord => ({
  id: 'x', chequeNo: '463831', chequeDate: '2026-10-05', periodMonth: '2026-09', kind: 'PAYROLL_ITEM',
  payeeName: 'CHAN TAI MAN', refLabel: 'Tai Man', clinicName: '大圍', accountLabel: '大圍', amount: 100,
  status: 'PRINTED', confirmed: true, printedByName: '老闆', printedAt: '2026-10-05T02:00:00.000Z',
  voidReason: null, voidedAt: null, ...over,
})

test('parseFilters：正常', () => {
  const r = parseFilters(new URLSearchParams({ from: '2026-08', to: '2026-09', kind: 'PAYOUT_RUN', status: 'VOID', q: '  chan ' }))
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.filters, { from: '2026-08', to: '2026-09', accountId: null, kind: 'PAYOUT_RUN', status: 'VOID', q: 'chan' })
})

test('parseFilters：錯月份／倒轉／超過 24 個月／錯類別狀態 → error', () => {
  assert.equal(parseFilters(new URLSearchParams({ from: '2026-13', to: '2026-09' })).ok, false)
  assert.equal(parseFilters(new URLSearchParams({ from: '2026-09', to: '2026-08' })).ok, false)
  assert.equal(parseFilters(new URLSearchParams({ from: '2024-01', to: '2026-01' })).ok, false) // 25 個月
  assert.equal(parseFilters(new URLSearchParams({ from: '2024-02', to: '2026-01' })).ok, true)  // 24 個月
  assert.equal(parseFilters(new URLSearchParams({ from: '2026-09', to: '2026-09', kind: 'X' })).ok, false)
  assert.equal(parseFilters(new URLSearchParams({ from: '2026-09', to: '2026-09', status: 'DONE' })).ok, false)
})

test('summarize：作廢唔計入已出票合計；按類別分', () => {
  const s = summarize([
    rec({ kind: 'PAYROLL_ITEM', amount: 6347.68 }),
    rec({ kind: 'PAYROLL_ITEM', amount: 18661.96 }),
    rec({ kind: 'PAYOUT_RUN', amount: 5000 }),
    rec({ kind: 'LAB_AMOUNT', amount: 1230, status: 'VOID', voidReason: '印歪' }),
    rec({ kind: 'LAB_AMOUNT', amount: 1230 }),
  ])
  assert.deepEqual(s.byKind.map(k => [k.kind, k.count, k.amount]), [['PAYROLL_ITEM', 2, 25009.64], ['PAYOUT_RUN', 1, 5000], ['LAB_AMOUNT', 1, 1230]])
  assert.deepEqual(s.printed, { count: 4, amount: 31239.64 })
  assert.deepEqual(s.void, { count: 1, amount: 1230 })
})

test('hkDateTime：UTC → 香港時間', () => {
  assert.equal(hkDateTime('2026-10-05T16:30:00.000Z'), '2026-10-06 00:30')
  assert.equal(hkDateTime(null), '')
  assert.equal(hkDateTime('bad'), '')
})

test('buildRecordsWorkbook：三個 sheet；作廢 sheet 只得作廢；金額係數字；「=」開頭唔會變公式', () => {
  const f: RecordFilters = { from: '2026-09', to: '2026-09', accountId: null, kind: null, status: null, q: null }
  const rows = [
    rec({ id: 'a', chequeNo: '000001', payeeName: '=HYPERLINK("x")', amount: 6347.68 }),
    rec({ id: 'b', chequeNo: '000002', status: 'VOID', voidReason: '印歪', voidedAt: '2026-10-05T03:00:00.000Z', amount: 99 }),
  ]
  const wb = buildRecordsWorkbook(rows, { filters: f, accountLabel: null, exportedAt: '2026-10-05T04:00:00.000Z' })
  assert.deepEqual(wb.SheetNames, ['全部', '作廢', '合計'])
  const back = XLSX.read(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }), { type: 'array' })
  const all = XLSX.utils.sheet_to_json<any[]>(back.Sheets['全部'], { header: 1 })
  assert.equal(all.length, 3) // header + 2
  assert.equal(all[0][0], '支票號')
  assert.equal(all[1][8], 6347.68)
  assert.equal(all[1][3], '=HYPERLINK("x")')
  assert.equal(back.Sheets['全部']['D2'].f, undefined) // 冇公式
  assert.equal(all[2][9], '已作廢')
  assert.equal(all[2][13], '印歪')
  const voided = XLSX.utils.sheet_to_json<any[]>(back.Sheets['作廢'], { header: 1 })
  assert.equal(voided.length, 2)
  assert.equal(voided[1][0], '000002')
  const sum = XLSX.utils.sheet_to_json<any[]>(back.Sheets['合計'], { header: 1 })
  const total = sum.find(r => r[0] === '合計（唔計作廢）')!
  assert.deepEqual(total.slice(1), [1, 6347.68])
  const v = sum.find(r => r[0] === '作廢')!
  assert.deepEqual(v.slice(1), [1, 99])
})

test('buildRecordsWorkbook：冇作廢 → 作廢 sheet 淨係表頭', () => {
  const f: RecordFilters = { from: '2026-09', to: '2026-09', accountId: null, kind: null, status: null, q: null }
  const wb = buildRecordsWorkbook([rec({})], { filters: f, accountLabel: '大圍', exportedAt: '2026-10-05T04:00:00.000Z' })
  const voided = XLSX.utils.sheet_to_json<any[]>(wb.Sheets['作廢'], { header: 1 })
  assert.equal(voided.length, 1)
})
