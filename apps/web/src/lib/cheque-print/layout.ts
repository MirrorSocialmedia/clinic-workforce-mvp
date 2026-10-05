// ============================================================
// ★ cwm-chequeprint-20261005：支票版面（mm，由支票左上角計）
//   匯豐冇公開欄位座標；香港支票一般約 180×88mm。預設值係估算，
//   第一次用要喺「校準」頁印白紙疊落真支票，睇偏幾多 mm 再調（每個版面一次）。
// ============================================================

export type Cpi = 10 | 12
export type PrinterMode = 'ESCP' | 'TEXT'

export interface FieldPos { x: number; y: number }
export interface LayoutFields {
  /** 支票紙尺寸（只用嚟畫預覽） */
  paper: { w: number; h: number }
  /** 日期 8 格 DDMMYYYY：第一格左上、每格闊、DD 同 MM 後面多咗嘅空位 */
  date: FieldPos & { pitch: number; gap1: number; gap2: number }
  payee: FieldPos & { width: number }
  words1: FieldPos & { width: number }
  words2: FieldPos & { width: number }
  amount: FieldPos & { width: number }
  /** 大寫用幾多 cpi（ESC/P 模式；TEXT 模式一律 10） */
  wordsCpi: Cpi
}

export const HSBC_DEFAULT_FIELDS: LayoutFields = {
  paper: { w: 180, h: 88 },
  date: { x: 131, y: 9, pitch: 5, gap1: 2, gap2: 2 },
  payee: { x: 20, y: 27, width: 150 },
  words1: { x: 52, y: 36.5, width: 88 },
  words2: { x: 12, y: 45, width: 128 },
  amount: { x: 141, y: 41, width: 37 },
  wordsCpi: 12,
}

const num = (v: unknown, d: number, min = -50, max = 300) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 10) / 10)) : d
}

/** 由 DB JSON 還原；壞咗或者缺欄就用預設 */
export function normalizeFields(raw: unknown): LayoutFields {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any
  const d = HSBC_DEFAULT_FIELDS
  const pos = <T extends FieldPos>(v: any, def: T): T => {
    const out: any = { ...def }
    for (const k of Object.keys(def)) out[k] = num(v?.[k], (def as any)[k], 0)
    return out
  }
  return {
    paper: { w: num(r.paper?.w, d.paper.w, 50), h: num(r.paper?.h, d.paper.h, 30) },
    date: pos(r.date, d.date),
    payee: pos(r.payee, d.payee),
    words1: pos(r.words1, d.words1),
    words2: pos(r.words2, d.words2),
    amount: pos(r.amount, d.amount),
    wordsCpi: r.wordsCpi === 10 ? 10 : 12,
  }
}

export const charMm = (cpi: Cpi) => 25.4 / cpi
export const charsFit = (widthMm: number, cpi: Cpi) => Math.max(1, Math.floor(widthMm / charMm(cpi) + 1e-6))

/** 一張支票要印嘅內容（已經整好字） */
export interface ChequeContent {
  /** YYYY-MM-DD */
  date: string
  payee: string
  words: [string, string]
  figures: string
}

/** 打印項目：x／y = 已加校準偏移嘅 mm */
export interface PrintItem { key: string; x: number; y: number; text: string; cpi: Cpi }

/** 日期 8 個位嘅 x（mm，未加偏移） */
export function dateDigitXs(f: LayoutFields['date']): number[] {
  const xs: number[] = []
  for (let i = 0; i < 8; i++) xs.push(f.x + i * f.pitch + (i >= 2 ? f.gap1 : 0) + (i >= 4 ? f.gap2 : 0))
  return xs
}

export function ddmmyyyy(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new Error('日期格式要 YYYY-MM-DD')
  return `${m[3]}${m[2]}${m[1]}`
}

/** 版面 + 內容 + 偏移 → 打印項目（預覽同打印機共用） */
export function layoutItems(f: LayoutFields, c: ChequeContent, off: { x: number; y: number }, mode: PrinterMode): PrintItem[] {
  const wc: Cpi = mode === 'TEXT' ? 10 : f.wordsCpi
  const items: PrintItem[] = []
  const digits = ddmmyyyy(c.date)
  // 日期每個字對準格中間：字闊 2.54mm（10cpi），所以由格左邊加 (pitch − 2.54)/2
  const pad = Math.max(0, (f.date.pitch - charMm(10)) / 2)
  dateDigitXs(f.date).forEach((x, i) => items.push({ key: `date${i}`, x: x + pad + off.x, y: f.date.y + off.y, text: digits[i], cpi: 10 }))
  items.push({ key: 'payee', x: f.payee.x + off.x, y: f.payee.y + off.y, text: c.payee, cpi: 10 })
  items.push({ key: 'words1', x: f.words1.x + off.x, y: f.words1.y + off.y, text: c.words[0], cpi: wc })
  items.push({ key: 'words2', x: f.words2.x + off.x, y: f.words2.y + off.y, text: c.words[1], cpi: wc })
  items.push({ key: 'amount', x: f.amount.x + off.x, y: f.amount.y + off.y, text: c.figures, cpi: 10 })
  return items
}

/** 各欄塞得落幾多字（打印中心驗證用） */
export function fieldChars(f: LayoutFields, mode: PrinterMode) {
  const wc: Cpi = mode === 'TEXT' ? 10 : f.wordsCpi
  return {
    payee: charsFit(f.payee.width, 10),
    words1: charsFit(f.words1.width, wc),
    words2: charsFit(f.words2.width, wc),
    amount: charsFit(f.amount.width, 10),
  }
}
