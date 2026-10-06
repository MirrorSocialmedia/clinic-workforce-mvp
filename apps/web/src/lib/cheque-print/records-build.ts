// ============================================================
// ★ cwm-chequerec-20261005：支票紀錄 —— 純函數（篩選驗證、合計、Excel）
//   唔掂 DB，方便單元測試；讀 DB 喺 records.ts。
//   Excel：三個 sheet —「全部」（連作廢）、「作廢」（老闆拍板：要另外一個 sheet）、「合計」。
// ============================================================
import * as XLSX from 'xlsx'

export type ChequeKind = 'PAYROLL_ITEM' | 'PAYOUT_RUN' | 'LAB_AMOUNT'
export const KIND_LABEL: Record<ChequeKind, string> = { PAYROLL_ITEM: '員工', PAYOUT_RUN: '醫生', LAB_AMOUNT: 'Lab' }
export const STATUS_LABEL: Record<string, string> = { PRINTED: '已出票', VOID: '已作廢' }

export interface RecordFilters {
  from: string // 'YYYY-MM'（計糧／月結月份）
  to: string
  accountId: string | null
  kind: ChequeKind | null
  status: 'PRINTED' | 'VOID' | null
  q: string | null
}

export interface ChequeRecord {
  id: string
  chequeNo: string
  chequeDate: string
  periodMonth: string
  kind: ChequeKind
  payeeName: string
  /** 對應人：員工花名／醫生「Dr.Ho · 何嘉俊」／Lab 名 */
  refLabel: string
  clinicName: string
  accountLabel: string
  amount: number
  status: string
  confirmed: boolean
  printedByName: string
  printedAt: string // ISO
  voidReason: string | null
  voidedAt: string | null // ISO
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
export const MAX_MONTH_SPAN = 24
export const MAX_ROWS = 5000

function monthIndex(m: string): number {
  return Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1
}

/** 由 query string 解析篩選；錯就回 error（中文） */
export function parseFilters(sp: URLSearchParams): { ok: true; filters: RecordFilters } | { ok: false; error: string } {
  const from = sp.get('from') ?? ''
  const to = sp.get('to') ?? ''
  if (!MONTH_RE.test(from) || !MONTH_RE.test(to)) return { ok: false, error: 'from／to 要係 YYYY-MM' }
  if (monthIndex(from) > monthIndex(to)) return { ok: false, error: '開始月份唔可以遲過結束月份' }
  if (monthIndex(to) - monthIndex(from) + 1 > MAX_MONTH_SPAN) return { ok: false, error: `最多揀 ${MAX_MONTH_SPAN} 個月` }
  const kindRaw = sp.get('kind') || null
  if (kindRaw && !(kindRaw in KIND_LABEL)) return { ok: false, error: '類別唔啱' }
  const statusRaw = sp.get('status') || null
  if (statusRaw && statusRaw !== 'PRINTED' && statusRaw !== 'VOID') return { ok: false, error: '狀態唔啱' }
  const q = (sp.get('q') ?? '').trim().slice(0, 60) || null
  return {
    ok: true,
    filters: { from, to, accountId: sp.get('accountId') || null, kind: kindRaw as ChequeKind | null, status: statusRaw as RecordFilters['status'], q },
  }
}

export interface Summary {
  byKind: Array<{ kind: ChequeKind; label: string; count: number; amount: number }>
  printed: { count: number; amount: number }
  void: { count: number; amount: number }
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** 合計：已出票（唔計作廢）按類別；作廢另計 */
export function summarize(rows: ChequeRecord[]): Summary {
  const kinds: ChequeKind[] = ['PAYROLL_ITEM', 'PAYOUT_RUN', 'LAB_AMOUNT']
  const byKind = kinds.map(kind => {
    const list = rows.filter(r => r.kind === kind && r.status !== 'VOID')
    return { kind, label: KIND_LABEL[kind], count: list.length, amount: r2(list.reduce((a, r) => a + r.amount, 0)) }
  })
  const printed = rows.filter(r => r.status !== 'VOID')
  const voided = rows.filter(r => r.status === 'VOID')
  return {
    byKind,
    printed: { count: printed.length, amount: r2(printed.reduce((a, r) => a + r.amount, 0)) },
    void: { count: voided.length, amount: r2(voided.reduce((a, r) => a + r.amount, 0)) },
  }
}

const HEADERS = ['支票號', '支票日期', '類別', '收款人（抬頭）', '對應', '診所', '月份', '戶口', '金額', '狀態', '已確認印得好', '打印人', '打印時間', '作廢原因', '作廢時間']

/** ISO → 'YYYY-MM-DD HH:mm'（香港時間） */
export function hkDateTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hk = new Date(d.getTime() + 8 * 3600_000)
  return hk.toISOString().slice(0, 16).replace('T', ' ')
}

function toRow(r: ChequeRecord): (string | number)[] {
  return [
    r.chequeNo, r.chequeDate, KIND_LABEL[r.kind], r.payeeName, r.refLabel, r.clinicName, r.periodMonth, r.accountLabel,
    r.amount, STATUS_LABEL[r.status] ?? r.status, r.status === 'VOID' ? '' : (r.confirmed ? '是' : '否'),
    r.printedByName, hkDateTime(r.printedAt), r.voidReason ?? '', hkDateTime(r.voidedAt),
  ]
}

function dataSheet(rows: ChequeRecord[]): XLSX.WorkSheet {
  // ⚠️ aoa_to_sheet 將字串寫成文字格（t:'s'），「=…」開頭都唔會變公式（冇 CSV 注入問題）
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows.map(toRow)])
  const amountCol = HEADERS.indexOf('金額')
  for (let i = 1; i <= rows.length; i++) {
    const cell = ws[XLSX.utils.encode_cell({ r: i, c: amountCol })]
    if (cell) cell.z = '#,##0.00'
  }
  ws['!cols'] = HEADERS.map(h => ({ wch: h === '收款人（抬頭）' || h === '對應' ? 28 : h === '作廢原因' ? 24 : 14 }))
  return ws
}

/** 三個 sheet：全部（連作廢）、作廢、合計 */
export function buildRecordsWorkbook(rows: ChequeRecord[], meta: { filters: RecordFilters; accountLabel: string | null; exportedAt: string }): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, dataSheet(rows), '全部')
  XLSX.utils.book_append_sheet(wb, dataSheet(rows.filter(r => r.status === 'VOID')), '作廢')
  const s = summarize(rows)
  const f = meta.filters
  const summary: (string | number)[][] = [
    ['支票紀錄'],
    ['月份', f.from === f.to ? f.from : `${f.from} 至 ${f.to}`],
    ['戶口', meta.accountLabel ?? '全部'],
    ['類別', f.kind ? KIND_LABEL[f.kind] : '全部'],
    ['狀態', f.status ? STATUS_LABEL[f.status] : '全部（連作廢）'],
    ['搜尋', f.q ?? ''],
    ['匯出時間', hkDateTime(meta.exportedAt)],
    [],
    ['類別', '已出票張數', '已出票金額'],
    ...s.byKind.map(k => [k.label, k.count, k.amount]),
    ['合計（唔計作廢）', s.printed.count, s.printed.amount],
    ['作廢', s.void.count, s.void.amount],
  ]
  const ws = XLSX.utils.aoa_to_sheet(summary)
  ws['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 16 }]
  XLSX.utils.book_append_sheet(wb, ws, '合計')
  return wb
}
