// ============================================================
// ★ cwm-chequeprint-20261005：支票版面（mm，由支票左上角計）
//   v2（2026-10-06）：按老闆張匯豐支票相＋白紙試印量度（支票約 160×85mm）；
//   每個欄位（日／月／年／抬頭／大寫兩行／金額）各自有 x、y，可以獨立移。
//   打印機起點偏移（offset）另計：打印機印唔到紙邊，試印量到約 +4.5／+4mm，所以預設 −4.5／−4。
// ============================================================

export type Cpi = 10 | 12 | 15
export type PrinterMode = 'ESCP' | 'TEXT'
export const CPIS: Cpi[] = [10, 12, 15]

export interface FieldPos { x: number; y: number }
export interface TextField extends FieldPos { width: number; cpi: Cpi }

export interface LayoutFields {
  v: 2
  /** 支票紙尺寸（預覽用） */
  paper: { w: number; h: number }
  /** 日期：日（2 位）、月（2 位）、年（4 位）各自位置；pitch = 每個數字之間距離 */
  day: FieldPos
  month: FieldPos
  year: FieldPos
  datePitch: number
  payee: TextField
  words1: TextField
  words2: TextField
  amount: TextField
}

export type FieldKey = 'day' | 'month' | 'year' | 'payee' | 'words1' | 'words2' | 'amount'
export const FIELD_KEYS: FieldKey[] = ['day', 'month', 'year', 'payee', 'words1', 'words2', 'amount']
export const FIELD_LABEL: Record<FieldKey, string> = {
  day: '日', month: '月', year: '年', payee: '抬頭', words1: '大寫第 1 行', words2: '大寫第 2 行', amount: '金額',
}
export const TEXT_FIELDS = ['payee', 'words1', 'words2', 'amount'] as const

export const HSBC_DEFAULT_FIELDS: LayoutFields = {
  v: 2,
  paper: { w: 160, h: 85 },
  day: { x: 116.5, y: 17.2 },
  month: { x: 125.5, y: 17.2 },
  year: { x: 134.5, y: 17.2 },
  datePitch: 4.4,
  payee: { x: 19, y: 27.6, width: 80, cpi: 10 },
  words1: { x: 27, y: 36.4, width: 72, cpi: 12 },
  words2: { x: 11, y: 45.7, width: 88, cpi: 12 },
  amount: { x: 113, y: 35.9, width: 36, cpi: 10 },
}
/** 白紙試印量到嘅打印機起點（印嘢位置 = 設定 + 起點），所以預設偏移係負數抵銷 */
export const HSBC_DEFAULT_OFFSET = { x: -4.5, y: -4 }

/** 匯豐支票本身印好嘅嘢（預覽背景，唔會印）—— 由老闆張相量度 */
export const HSBC_ARTWORK = {
  dateBoxes: [{ x: 115.3, w: 9.3 }, { x: 125, w: 8 }, { x: 133.5, w: 17.8 }], dateBoxY: 14.4, dateBoxH: 8.6,
  lines: [{ x1: 10, x2: 99, y: 31.4 }, { x1: 10, x2: 99, y: 40.2 }, { x1: 10, x2: 99, y: 49.5 }],
  payeeOnlyBox: { x: 66.7, y: 25.5, w: 9.5, h: 26.5 },
  amountBox: { x: 110.8, y: 33, w: 39.2, h: 8.8 },
  labels: [
    { x: 9.5, y: 27.5, t: 'Pay 祈付' }, { x: 9.5, y: 36.5, t: 'HK dollars 港幣' }, { x: 104, y: 39, t: 'HK$' },
    { x: 9.5, y: 7, t: 'HSBC 匯豐' }, { x: 116, y: 25.5, t: 'Day 日  Month 月   Year 年' },
    { x: 9.5, y: 58, t: 'For and on behalf of（公司名）' },
  ],
  micrY: 79,
}

const num = (v: unknown, d: number, min = 0, max = 300) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 10) / 10)) : d
}
const cpiOf = (v: unknown, d: Cpi): Cpi => (v === 10 || v === 12 || v === 15 ? v : d)

/** 由 DB JSON 還原；舊版（v1）或者壞咗 → null（由 caller 換做預設） */
export function normalizeFields(raw: unknown): LayoutFields | null {
  const r = (raw && typeof raw === 'object' ? raw : null) as any
  if (!r || r.v !== 2) return null
  const d = HSBC_DEFAULT_FIELDS
  const pos = (v: any, def: FieldPos): FieldPos => ({ x: num(v?.x, def.x), y: num(v?.y, def.y) })
  const txt = (v: any, def: TextField): TextField => ({ ...pos(v, def), width: num(v?.width, def.width, 5), cpi: cpiOf(v?.cpi, def.cpi) })
  return {
    v: 2,
    paper: { w: num(r.paper?.w, d.paper.w, 50), h: num(r.paper?.h, d.paper.h, 30) },
    day: pos(r.day, d.day), month: pos(r.month, d.month), year: pos(r.year, d.year),
    datePitch: num(r.datePitch, d.datePitch, 2, 15),
    payee: txt(r.payee, d.payee), words1: txt(r.words1, d.words1), words2: txt(r.words2, d.words2), amount: txt(r.amount, d.amount),
  }
}

/** 所有欄位一齊移 */
export function shiftAll(f: LayoutFields, dx: number, dy: number): LayoutFields {
  const out: any = { ...f }
  for (const k of FIELD_KEYS) out[k] = { ...(f as any)[k], x: num((f as any)[k].x + dx, 0), y: num((f as any)[k].y + dy, 0) }
  return out
}

export const charMm = (cpi: Cpi) => 25.4 / cpi
export const charsFit = (widthMm: number, cpi: Cpi) => Math.max(1, Math.floor(widthMm / charMm(cpi) + 1e-6))

/** 一張支票要印嘅內容（已經整好字＋實際用嘅字距） */
export interface ChequeContent {
  /** YYYY-MM-DD */
  date: string
  payee: string
  words: [string, string]
  figures: string
  cpi: { payee: Cpi; words: Cpi; amount: Cpi }
}

/** 打印項目：x／y = mm（打印時已加起點偏移） */
export interface PrintItem { key: string; x: number; y: number; text: string; cpi: Cpi }

export function ddmmyyyy(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new Error('日期格式要 YYYY-MM-DD')
  return `${m[3]}${m[2]}${m[1]}`
}

/** 版面 + 內容 + 偏移 → 打印項目（預覽用 off = 0；打印用打印機起點偏移） */
export function layoutItems(f: LayoutFields, c: ChequeContent, off: { x: number; y: number }, mode: PrinterMode): PrintItem[] {
  const t = (cpi: Cpi): Cpi => (mode === 'TEXT' ? 10 : cpi)
  const items: PrintItem[] = []
  const digits = ddmmyyyy(c.date)
  const groups: Array<[FieldPos, string, string]> = [[f.day, digits.slice(0, 2), 'day'], [f.month, digits.slice(2, 4), 'month'], [f.year, digits.slice(4), 'year']]
  for (const [p, s, k] of groups) {
    for (let i = 0; i < s.length; i++) items.push({ key: `${k}${i}`, x: p.x + i * f.datePitch + off.x, y: p.y + off.y, text: s[i], cpi: 10 })
  }
  items.push({ key: 'payee', x: f.payee.x + off.x, y: f.payee.y + off.y, text: c.payee, cpi: t(c.cpi.payee) })
  items.push({ key: 'words1', x: f.words1.x + off.x, y: f.words1.y + off.y, text: c.words[0], cpi: t(c.cpi.words) })
  items.push({ key: 'words2', x: f.words2.x + off.x, y: f.words2.y + off.y, text: c.words[1], cpi: t(c.cpi.words) })
  items.push({ key: 'amount', x: f.amount.x + off.x, y: f.amount.y + off.y, text: c.figures, cpi: t(c.cpi.amount) })
  return items
}

/** 由設定嘅字距開始，塞唔落就自動縮細（ESC/P 先得；TEXT 一律 10 cpi） */
export function cpiChoices(pref: Cpi, mode: PrinterMode): Cpi[] {
  if (mode === 'TEXT') return [10]
  return CPIS.filter(c => c >= pref)
}
