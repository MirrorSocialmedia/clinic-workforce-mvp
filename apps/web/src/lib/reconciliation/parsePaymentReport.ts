// ★ MD-E: Parse Apricot monthly payment report xlsx
// 只讀三欄：Date / Transaction Code / Total Charges — PII 唔存

import * as XLSX from 'xlsx'

export interface ParsedRow {
	date: string // YYYY-MM-DD
	code: string
	amount: number
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
	let practitioner = ''
	let clinic = ''
	let month = ''
	for (let i = 0; i < Math.min(10, raw.length); i++) {
		const row = raw[i]
		for (const cell of row || []) {
			const s = String(cell).trim()
			if (s.startsWith('Practitioner:'))
				practitioner = s.replace(/^Practitioner:\s*/i, '').trim()
			if (s.startsWith('Clinic:'))
				clinic = s.replace(/^Clinic:\s*/i, '').trim()
			if (s.startsWith('Month:'))
				month = s.replace(/^Month:\s*/i, '').trim()
		}
	}
	if (!month) {
		throw new Error('REPORT_META_MISSING: 搵唔到 Month')
	}
	return { practitioner, clinic, month }
}

function mapColumns(headerRow: any[]): { date: number; code: number; amount: number } {
	const cols: { date?: number; code?: number; amount?: number } = {}
	headerRow.forEach((c: any, i: number) => {
		const s = String(c).trim()
		if (s === 'Date') cols.date = i
		if (s === 'Transaction Code') cols.code = i
		if (s === 'Total Charges') cols.amount = i
	})
	if (cols.date === undefined || cols.code === undefined || cols.amount === undefined) {
		throw new Error('REPORT_FORMAT_CHANGED: 缺少必要欄位')
	}
	return cols as { date: number; code: number; amount: number }
}
