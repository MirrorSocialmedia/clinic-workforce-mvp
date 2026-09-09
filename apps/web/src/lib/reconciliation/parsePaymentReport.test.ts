// ★ MD-AC1: parsePaymentReport unit tests
// 跑法: npx tsx --test src/lib/reconciliation/parsePaymentReport.test.ts
// 用 Node 22 內建 test runner，唔加新 dependency
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { parsePaymentReport } from './parsePaymentReport'

// ---- helpers -------------------------------------------------------------

const META = ['Practitioner: Dr. Lau Ho Yin', 'Clinic: Mei Foo', 'Month: 2026-07']
const HEADER = ['Date', 'Transaction Code', 'Total Charges', 'Total Paid']

/** 由 array-of-arrays 造 xlsx buffer（cells 可以用 { t, v, z } cell object） */
function buildBuf(rows: any[][]): Buffer {
	const ws = XLSX.utils.aoa_to_sheet(rows)
	const wb = XLSX.utils.book_new()
	XLSX.utils.book_append_sheet(wb, ws, 'Payment Report')
	return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

function report(dataRows: any[][]): ReturnType<typeof parsePaymentReport> {
	return parsePaymentReport(buildBuf([META, [], HEADER, ...dataRows]))
}

// ---- tests ----------------------------------------------------------------

describe('parsePaymentReport', () => {
	it('正常行解析（DD/MM/YYYY + 千分位金額）', () => {
		const { meta, rows, skipped } = report([
			['05/07/2026', '202607050001', '50,000.00', '50,000.00'],
			['06/07/2026', '202607060002', '1,234.56', '1,200.00'],
		])
		assert.equal(meta.month, '2026-07')
		assert.equal(meta.clinic, 'Mei Foo')
		assert.equal(meta.practitioner, 'Dr. Lau Ho Yin')
		assert.equal(rows.length, 2)
		assert.equal(skipped, 0)
		assert.deepEqual(rows[0], {
			date: '2026-07-05',
			code: '202607050001',
			amount: 50000,
			charges: 50000,
			paid: 50000,
			method: '', // ★ C1：舊格式冇 Payment Method 欄 = ''（唔准必填）
		})
		assert.equal(rows[1].date, '2026-07-06')
		assert.equal(rows[1].charges, 1234.56)
		assert.equal(rows[1].paid, 1200)
	})

	it('分拆付款行（Date 空）→ 承接上一行日期，兩行都入', () => {
		const { rows, skipped } = report([
			['05/07/2026', '202607050007', '50,000.00', '50,000.00'],
			[null, '202607050007', '0.00', '0.00'], // ★ 同一 code 第二行，Date 空
		])
		assert.equal(skipped, 0)
		assert.equal(rows.length, 2)
		assert.equal(rows[0].date, '2026-07-05')
		assert.equal(rows[1].date, '2026-07-05') // ★ 承接
		assert.equal(rows[1].code, '202607050007')
	})

	it('第一行就冇日期 → 冇得承接，skipped++ 唔崩', () => {
		const { rows, skipped } = report([
			[null, '202607010000', '100.00', '100.00'], // 第一行就空 → skip
			['05/07/2026', '202607050007', '50,000.00', '50,000.00'],
			[null, '202607050007', '0.00', '0.00'], // 承接
		])
		assert.equal(skipped, 1)
		assert.equal(rows.length, 2)
		assert.equal(rows[0].date, '2026-07-05')
		assert.equal(rows[1].date, '2026-07-05')
	})

	it('日期亂碼行 → skipped++，其餘照解析', () => {
		const { rows, skipped } = report([
			['05/07/2026', '202607050001', '50,000.00', '50,000.00'],
			['###garbled###', '202607050002', '9,999.99', '9,999.99'], // ★ 爛
			['06/07/2026', '202607060003', '1,000.00', '1,000.00'],
		])
		assert.equal(skipped, 1)
		assert.equal(rows.length, 2)
		// 爛行嘅金額唔應該入
		const total = rows.reduce((s, r) => s + r.amount, 0)
		assert.equal(total, 51000)
	})

	it('全部日期爛 → CONTRACT_BROKEN（唔可以靜靜返 $0）', () => {
		assert.throws(
			() =>
				report([
					['garbled-1', '202607010001', '100.00', '100.00'],
					['garbled-2', '202607020002', '200.00', '200.00'],
					['garbled-3', '202607030003', '300.00', '300.00'],
					['garbled-4', '202607040004', '400.00', '400.00'],
				]),
			/REPORT_CONTRACT_BROKEN/,
		)
	})

	it('Excel serial number 日期（date-format cell）', () => {
		// 46212 = 2026-07-09（Excel epoch 1899-12-30）
		const { rows, skipped } = report([
			[{ t: 'n', v: 46212, z: 'yyyy-mm-dd' }, '202607090001', '1,000.00', '1,000.00'],
		])
		assert.equal(skipped, 0)
		assert.equal(rows.length, 1)
		assert.equal(rows[0].date, '2026-07-09')
	})

	it('DD/MM/YYYY 格式（單一位日/月亦要 pad）', () => {
		const { rows } = report([
			['5/7/2026', '202607050001', '100.00', '100.00'],
			['05-07-2026', '202607050002', '100.00', '100.00'],
		])
		assert.equal(rows[0].date, '2026-07-05')
		assert.equal(rows[1].date, '2026-07-05')
	})

	it('金額：千分位 / $ 符號 / 括號負數', () => {
		const { rows } = report([
			['01/07/2026', '202607010001', '1,234.56', '1,234.56'], // 千分位
			['02/07/2026', '202607020002', '$2,000.00', '$2,000.00'], // $ 符號
			['03/07/2026', '202607030003', '(1,000.00)', '(1,000.00)'], // 括號負數
		])
		assert.equal(rows[0].charges, 1234.56)
		assert.equal(rows[1].charges, 2000)
		assert.equal(rows[2].charges, -1000)
		assert.equal(rows[2].paid, -1000)
	})

	it('Total / 小計 行跳過（唔計入 rows 都唔計 skipped）', () => {
		const { rows, skipped } = report([
			['05/07/2026', '202607050001', '50,000.00', '50,000.00'],
			['Total', 'x', '50,000.00', '50,000.00'],
			['小計', 'x', '1.00', '1.00'],
		])
		assert.equal(rows.length, 1)
		assert.equal(skipped, 0)
	})
})
