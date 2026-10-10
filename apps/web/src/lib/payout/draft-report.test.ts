/**
 * ★ cwm-feefmt-20261006 ＋ cwm-draftreport-20261006：全店月報
 *   ① Clinic 雜項頁逐行費率（Octopus 2% + FPS 0% 唔准再顯示成「0.2%」）、手續費合計、淨額
 *   ② 未鎖定醫生草稿頁：狀態行黃底、上期調整攞「未掛 run」嗰批、行號同鎖定頁一樣
 *   ③ 封面：草稿行黃底、合計拆「已鎖定／草稿」、計唔到嘅醫生列名＋原因
 * 純 ExcelJS ＋ fake db，零 DB 依賴。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import ExcelJS from 'exceljs'
import { loadDoctorSheetDataForRun } from './report-data'
import { buildCoverSheet, buildDoctorSheet, buildMiscSheet, FILL_DRAFT, LABEL_MISC_NET, LABEL_PAYABLE, PCT_FMT } from './xlsx-report'

const text = (v: ExcelJS.CellValue): string => {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && 'result' in (v as object)) return String((v as { result: unknown }).result ?? '')
  return ''
}
const rowOf = (ws: ExcelJS.Worksheet, label: string): number => {
  for (let r = 1; r <= 300; r++) if (text(ws.getCell(r, 1).value) === label) return r
  return -1
}
const num = (ws: ExcelJS.Worksheet, r: number, c: number): number => {
  const v = ws.getCell(r, c).value
  if (typeof v === 'number') return v
  return Number((v as { result?: unknown })?.result ?? NaN)
}
const formula = (ws: ExcelJS.Worksheet, r: number, c: number): string =>
  String((ws.getCell(r, c).value as { formula?: string })?.formula ?? '')
const fillOf = (ws: ExcelJS.Worksheet, r: number, c: number): string | undefined =>
  ((ws.getCell(r, c).fill as ExcelJS.FillPattern | undefined)?.fgColor as { argb?: string } | undefined)?.argb

test('雜項頁：逐行費率 2.00%／0.00%，手續費合計 = Σ逐行，淨額 = 合計 − 手續費', () => {
  const wb = new ExcelJS.Workbook()
  const ws = buildMiscSheet(wb, {
    clinicName: 'TC',
    periodMonth: '2026-09',
    rows: [
      { incomeAt: '2026-09-03', category: 'PRODUCT', itemName: '牙刷', methodLabel: 'Octopus', amount: 40, feePercent: 0.02, fee: 0.8 },
      { incomeAt: '2026-09-04', category: 'OTHER', itemName: '證明書', methodLabel: 'FPS', amount: 300, feePercent: 0, fee: 0 },
    ],
  })
  // 表頭第 7、8 欄 = 費率、手續費
  let hdr = -1
  for (let r = 1; r <= 20; r++) if (text(ws.getCell(r, 1).value) === '日期') { hdr = r; break }
  assert.ok(hdr > 0)
  assert.strictEqual(text(ws.getCell(hdr, 7).value), '費率')
  assert.strictEqual(text(ws.getCell(hdr, 8).value), '手續費')
  assert.strictEqual(num(ws, hdr + 1, 7), 0.02)
  assert.strictEqual(ws.getCell(hdr + 1, 7).numFmt, PCT_FMT)
  assert.strictEqual(PCT_FMT, '0.00%') // 0.235% 唔可以再顯示成「0.2%」
  assert.strictEqual(num(ws, hdr + 1, 8), 0.8)
  assert.strictEqual(num(ws, hdr + 2, 7), 0)

  const total = rowOf(ws, '合計')
  const fee = rowOf(ws, '減：手續費合計')
  const net = rowOf(ws, LABEL_MISC_NET)
  assert.strictEqual(num(ws, total, 6), 340)
  assert.strictEqual(num(ws, fee, 6), 0.8)
  assert.strictEqual(formula(ws, net, 6), `F${total}-F${fee}`)
  assert.strictEqual(num(ws, net, 6), 339.2)
  // 唔准再有「手續費率」加權平均一行
  for (let r = 1; r <= 60; r++) assert.ok(!text(ws.getCell(r, 1).value).includes('手續費率'))
})

function fakeDb(captured: { adjWhere?: unknown }) {
  return {
    provider: { findUnique: async () => ({ id: 'p1', name: 'Dr. Draft', shortName: 'DrD' }) },
    clinic: { findUnique: async () => ({ id: 'c1', name: 'Test Clinic', shortName: 'TC', apricotClinicId: 'cx' }) },
    apricotPractitioner: { findMany: async () => [{ apricotId: 'px' }] },
    paymentAllocation: { findMany: async () => [] },
    apricotBill: { findMany: async () => [] },
    spSubsidy: { findMany: async () => [] },
    providerReferral: { findMany: async () => [] },
    payoutAdjustment: {
      findMany: async (q: { where: unknown }) => {
        captured.adjWhere = q.where
        return [{ refCode: 'ADJ1', createdAt: new Date('2026-09-20T04:00:00Z'), reason: '上月少計', note: '', amount: 100 }]
      },
    },
    costCase: { findMany: async () => [] },
    materialItem: { findMany: async () => [] },
  }
}

const draftRun = (status: 'DRAFT' | 'LOCKED') => ({
  id: status === 'DRAFT' ? 'draft:p1' : 'run1',
  providerId: 'p1',
  clinicId: 'c1',
  periodMonth: '2026-09',
  status,
  lockedAt: status === 'LOCKED' ? new Date('2026-10-02T04:00:00Z') : null,
  breakdownJson: {
    allocations: [
      { method: 'CASH', rawAmount: 1000, netAmount: 1000, feePercentUsed: 0, countAsIncome: true, paidAt: new Date('2026-09-05T04:00:00Z') },
      { method: 'OCTOPUS', rawAmount: 500, netAmount: 490, feePercentUsed: 2, countAsIncome: true, paidAt: new Date('2026-09-06T04:00:00Z') },
    ],
  },
  percentUsed: 50,
  totalAmount: 845, // (1000 + 490) × 50% + 100 調整
}) as never

test('草稿頁：上期調整攞未掛 run 嗰批（同 engine ⑦）、狀態黃底、應付 = 即時總額、行號同鎖定頁一樣', async () => {
  const cap: { adjWhere?: unknown } = {}
  const draft = await loadDoctorSheetDataForRun(draftRun('DRAFT'), fakeDb(cap), { liveDraft: true })
  assert.deepStrictEqual(cap.adjWhere, { providerId: 'p1', periodMonth: '2026-09', runId: null, clinicId: 'c1' })
  assert.strictEqual(draft.data.draft, true)
  assert.match(draft.data.status, /^草稿（未鎖定）/)

  const capL: { adjWhere?: unknown } = {}
  const locked = await loadDoctorSheetDataForRun(draftRun('LOCKED'), fakeDb(capL))
  assert.deepStrictEqual(capL.adjWhere, { runId: 'run1' })
  assert.strictEqual(locked.data.draft, false)

  const wb = new ExcelJS.Workbook()
  const d = buildDoctorSheet(wb, draft.data)
  const l = buildDoctorSheet(wb, locked.data)
  assert.strictEqual(d.payable, 845)
  assert.strictEqual(l.payable, 845)
  assert.strictEqual(fillOf(d.ws, 2, 1), FILL_DRAFT)
  assert.strictEqual(d.ws.properties.tabColor?.argb, FILL_DRAFT)
  assert.strictEqual(fillOf(l.ws, 2, 1), undefined)
  assert.strictEqual(rowOf(d.ws, LABEL_PAYABLE), rowOf(l.ws, LABEL_PAYABLE)) // 唔加行，封面連結照搵到
})

test('封面：草稿行黃底、合計拆已鎖定／草稿、計唔到嘅醫生列名＋原因', () => {
  const wb = new ExcelJS.Workbook()
  const cover = buildCoverSheet(wb, {
    clinicName: 'TC',
    periodMonth: '2026-09',
    doctors: [
      { providerName: 'DrL', sheetName: 'none-L', status: 'LOCKED（已鎖定 2/10/2026）', totalAmount: 1000, revenue: 3000, freeSp: 0, credit: 0, methodCount: 1 },
      { providerName: 'DrD', sheetName: 'none-D', status: '草稿（未鎖定）', draft: true, totalAmount: 400, revenue: 900, freeSp: 0, credit: 0, methodCount: 1 },
    ],
    miscNet: 0,
    failures: [{ providerName: 'DrX', reason: 'PAYOUT_NO_COMMISSION' }],
  })
  const rL = rowOf(cover, 'DrL')
  const rD = rowOf(cover, 'DrD')
  assert.strictEqual(fillOf(cover, rL, 1), undefined)
  for (let c = 1; c <= 4; c++) assert.strictEqual(fillOf(cover, rD, c), FILL_DRAFT)

  const total = rowOf(cover, '合計')
  assert.strictEqual(num(cover, total, 4), 1400)
  const lockedRow = rowOf(cover, '  其中：已鎖定')
  const draftRow = rowOf(cover, '  其中：草稿（未鎖定）')
  assert.strictEqual(formula(cover, lockedRow, 4), `SUM(D${rL})`)
  assert.strictEqual(num(cover, lockedRow, 4), 1000)
  assert.strictEqual(formula(cover, draftRow, 4), `SUM(D${rD})`)
  assert.strictEqual(num(cover, draftRow, 4), 400)
  assert.strictEqual(num(cover, draftRow, 3), 900)

  let note = false
  let failHdr = -1
  for (let r = 1; r <= 60; r++) {
    const t = text(cover.getCell(r, 1).value)
    if (t.startsWith('※ 黃底 = 草稿')) note = true
    if (t.startsWith('未能計算')) failHdr = r
  }
  assert.ok(note, '有草稿要出黃底說明')
  assert.ok(failHdr > 0, '要列出未能計算嘅醫生')
  assert.strictEqual(text(cover.getCell(failHdr + 1, 1).value).trim(), 'DrX')
  assert.strictEqual(text(cover.getCell(failHdr + 1, 2).value), 'PAYOUT_NO_COMMISSION')
})

test('封面：全部已鎖定 → 草稿合計 0、冇黃底說明、冇未能計算區', () => {
  const wb = new ExcelJS.Workbook()
  const cover = buildCoverSheet(wb, {
    clinicName: 'TC',
    periodMonth: '2026-09',
    doctors: [{ providerName: 'DrL', sheetName: 'x', status: 'LOCKED', totalAmount: 10, revenue: 20, freeSp: 0, credit: 0, methodCount: 1 }],
    miscNet: 0,
  })
  const draftRow = rowOf(cover, '  其中：草稿（未鎖定）')
  assert.strictEqual(num(cover, draftRow, 4), 0)
  assert.strictEqual(fillOf(cover, draftRow, 1), undefined)
  for (let r = 1; r <= 60; r++) {
    const t = text(cover.getCell(r, 1).value)
    assert.ok(!t.startsWith('※ 黃底') && !t.startsWith('未能計算'))
  }
})
