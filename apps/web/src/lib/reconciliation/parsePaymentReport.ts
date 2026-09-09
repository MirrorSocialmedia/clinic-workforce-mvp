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
	// ★ MD-AC1: 日期解析唔到嘅行數 — 必須回報，唔好靜靜跳過
	skipped: number
	// ★ cwm-recon-clinic-20260909 B3: 冇 Transaction Code 嘅空行 — 同 skipped 分開計（「空行」唔係警告）
	blankRows: number
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
	// ★ MD-AC1：同一個 Transaction Code 會出多行（一筆付款拆幾個付款方式），
	//   第二行只有金額、Date 格係空 → 承接上一行日期（lastDate）。
	const rows: ParsedRow[] = []
	let lastDate: string | null = null
	let skipped = 0
	let blankRows = 0 // ★ cwm-recon-clinic-20260909 B3
	for (let i = headerRow + 1; i < raw.length; i++) {
		const r = raw[i]
		// ★ cwm-recon-clinic-20260909 B1：GRAND TOTAL 之後係「付款方式小計表」
		//   （A欄 = 方式名、B欄 = 金額）。parser 攞 A 欄當日期梗係解析唔到 →
		//   之前會報「跳過 10 行」，嚇到人以為漏咗錢，其實一蚊都冇漏。
		//   ★ 實測 TW 2026-08：第 195 行 GRAND TOTAL、第 197-206 行就係嗰 10 行。
		if (r && r.some((c: any) => /grand\s*total/i.test(String(c ?? '')))) break
		if (!r || !r[cols.code]) { blankRows++; continue } // ★ B3：空行計數（唔係 skipped）
		const dateStr = String(r[cols.date] ?? '').trim()
		if (/total|小計|合計/i.test(dateStr)) continue

		let date: string
		if (dateStr) {
			const parsed = parseHKDate(r[cols.date])
			if (!parsed) {
				// ★ 一行爛資料唔應該毀晒成個上載 — 跳過呢行，但一定要計數回報
				// ★ B2：一定要清 lastDate —— 唔清嘅話，呢一行嘅【拆分行】（空日期）
				//   會承接上一張單嘅日期，靜靜入錯日而且唔會計入 skipped
				lastDate = null
				skipped++
				continue
			}
			date = parsed
			lastDate = parsed
		} else if (lastDate) {
			date = lastDate // ★ 空日期 = 上一筆付款嘅分拆行
		} else {
			// 第一行就冇日期 → 冇得承接
			skipped++
			continue
		}

		rows.push({
			date,
			code: String(r[cols.code]).trim(),
			amount: parseAmount(r[cols.amount]),
			// ★ AA2: 兩個金額欄都讀
			charges: cols.charges !== undefined ? parseAmount(r[cols.charges]) : null,
			paid: cols.paid !== undefined ? parseAmount(r[cols.paid]) : null,
		})
	}

	// 4) CONTRACT_BROKEN 檢查：有資料行但零行解析成功
	// ★ MD-AC1：守衛保留 — 零行解析成功 = 格式徹底變咗，唔好靜靜返 $0
	if (raw.length > headerRow + 3 && rows.length === 0) {
		throw new Error('REPORT_CONTRACT_BROKEN: 有資料行但零行解析成功')
	}

	return { meta, rows, skipped, blankRows }
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
// ★ MD-AC1: 解析唔到回 null，唔好 throw —— 一行爛資料唔應該毀晒成個上載
function parseHKDate(v: any): string | null {
	if (v == null || v === '') return null
	// 處理 Excel serial number
	if (typeof v === 'number') {
		const d = new Date((v - 25569) * 86400 * 1000)
		return isNaN(+d) ? null : d.toISOString().split('T')[0]
	}
	const s = String(v).trim()
	// DD/MM/YYYY
	const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/)
	if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
	// YYYY-MM-DD
	const m2 = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/)
	if (m2) return `${m2[1]}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`
	return null
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
