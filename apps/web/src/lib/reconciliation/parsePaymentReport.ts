// ★ MD-E: Parse Apricot monthly payment report xlsx
// 只讀三欄：Date / Transaction Code / Total Charges — PII 唔存

import * as XLSX from 'xlsx'

export interface ParsedRow {
	date: string // YYYY-MM-DD
	code: string
	amount: number
	charges: number | null // ★ AA2: Total Charges
	paid: number | null // ★ AA2: Total Paid
}

export interface ParsedReport {
	meta: { practitioner: string; clinic: string; month: string }
	rows: ParsedRow[]
}

export function parsePaymentReport(buf: Buffer): ParsedReport {
	const wb = XLSX.read(buf, { type: 'buffer' })
	const sheet = wb.Sheets[wb.SheetNames[0]]
	const raw = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, raw: false })

	// 1) extractMeta: 由頭幾行搵 Practitioner / Clinic / Month
	const meta = extractMeta(raw)

	// 2) 搵欄位標題行（★ 按名唔按位置）
	const headerRow = raw.findIndex(
		(r: any) => r && r.some((c: any) => String(c).trim() === 'Transaction Code'),
	)
	if (headerRow < 0) {
		throw new Error('REPORT_FORMAT_CHANGED: 搵唔到 Transaction Code 欄')
	}

	const cols = mapColumns(raw[headerRow]) // { date, code, amount }

	// 3) 讀資料行，跳過小計 / 空行
	const rows: ParsedRow[] = []
	for (let i = headerRow + 1; i < raw.length; i++) {
		const r = raw[i]
		if (!r || !r[cols.code]) continue
		const dateStr = String(r[cols.date] ?? '').trim()
		if (/total|小計|合計/i.test(dateStr)) continue
		rows.push({
			date: parseHKDate(r[cols.date]),
			code: String(r[cols.code]).trim(),
			amount: parseAmount(r[cols.amount]),
			// ★ AA2: 兩個金額欄都讀
			charges: cols.charges !== undefined ? parseAmount(r[cols.charges]) : null,
			paid: cols.paid !== undefined ? parseAmount(r[cols.paid]) : null,
		})
	}

	// 4) CONTRACT_BROKEN 檢查：有資料行但零行解析成功
	if (raw.length > headerRow + 3 && rows.length === 0) {
		throw new Error('REPORT_CONTRACT_BROKEN: 有資料行但零行解析成功')
	}

	return { meta, rows }
}

// parseAmount: 處理千分位逗號、$ 符號、括號負數、空白、/
function parseAmount(v: any): number {
	const s = String(v ?? '').replace(/[$,\s]/g, '')
	if (!s || s === '/' || s === '-') return 0
	const neg = /^\(.*\)$/.test(s)
	const val = parseFloat(s.replace(/[()]/g, '') || '0')
	return neg ? -val : val
}

// parseHKDate: 處理 Apricot 日期格式（可能係 Excel serial, DD/MM/YYYY, 等）
function parseHKDate(v: any): string {
	// 處理 Excel serial number
	if (typeof v === 'number') {
		const date = new Date((v - 25569) * 86400 * 1000)
		return date.toISOString().split('T')[0]
	}
	const s = String(v).trim()
	// DD/MM/YYYY
	const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/)
	if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
	// YYYY-MM-DD
	const m2 = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/)
	if (m2) return `${m2[1]}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`
	throw new Error(`Cannot parse date: ${v}`)
}

function extractMeta(
	raw: any[],
): { practitioner: string; clinic: string; month: string } {
	let practitioner = '', clinic = '', month = ''

	const readLabelled = (row: any[], idx: number, label: string): string => {
		const s = String(row[idx] ?? '').trim()
		// 同一 cell 入面有值（inline）
		const inline = s.replace(new RegExp(`^${label}\\s*:?\\s*`, 'i'), '').trim()
		if (inline) return inline
		// 同一行往右搵第一個非空 cell（雙 cell 格式：A="Month:" B="2026-07"）
		for (let j = idx + 1; j < row.length; j++) {
			const v = String(row[j] ?? '').trim()
			if (v) return v
		}
		return ''
	}

	for (let i = 0; i < Math.min(10, raw.length); i++) {
		const row = raw[i] || []
		for (let j = 0; j < row.length; j++) {
			const s = String(row[j] ?? '').trim()
			if (/^practitioner\s*:/i.test(s)) practitioner = readLabelled(row, j, 'Practitioner')
			if (/^clinic\s*:/i.test(s)) clinic = readLabelled(row, j, 'Clinic')
			if (/^month\s*:/i.test(s)) month = readLabelled(row, j, 'Month')
		}
	}

	if (!month) {
		throw new Error(
			'REPORT_META_MISSING: 搵唔到 Month。' +
			'請確認上載嘅係 Apricot「Practitioner Payment Report」xlsx，' +
			'而且頭幾行有 Practitioner / Clinic / Month'
		)
	}
	return { practitioner, clinic, month }
}

function mapColumns(headerRow: any[]): { date: number; code: number; amount: number; charges?: number; paid?: number } {
	const cols: { date?: number; code?: number; amount?: number; charges?: number; paid?: number } = {}
	headerRow.forEach((c: any, i: number) => {
		const s = String(c).trim()
		if (s === 'Date') cols.date = i
		if (s === 'Transaction Code') cols.code = i
		if (s === 'Total Charges') {
			cols.charges = i
			//  backwards compat: amount 仍然指向 charges
			cols.amount = i
		}
		if (s === 'Total Paid') cols.paid = i
	})
	if (cols.date === undefined || cols.code === undefined) {
		throw new Error('REPORT_FORMAT_CHANGED: 缺少 Date 或 Transaction Code 欄')
	}
	if (cols.charges === undefined && cols.paid === undefined) {
		throw new Error('REPORT_FORMAT_CHANGED: 搵唔到 Total Charges 或 Total Paid 欄')
	}
	if (cols.amount === undefined && cols.charges !== undefined) {
		cols.amount = cols.charges
	}
	return cols as { date: number; code: number; amount: number; charges?: number; paid?: number }
}
