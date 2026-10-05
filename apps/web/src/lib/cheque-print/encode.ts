// ============================================================
// ★ cwm-chequeprint-20261005：打印機指令（Chrome WebUSB 直送，冇 driver）
//   ESCP：Epson ESC/P（LQ 24 針）— 1/180" 直移、1/60" 橫向定位，準到 0.15mm；中文抬頭用點陣圖（ESC * 39）。
//   TEXT：純文字（空格＋換行），任何仿真模式都識；10 cpi × 6 lpi，位置會黐埋 2.54 × 4.23 mm 格。
//   兩種都用 FF（0x0C）出紙。打印機設定成邊種，用「打印機測試」頁試。
// ============================================================
import type { PrintItem } from './layout'

const ESC = 0x1b
const MM_PER_INCH = 25.4

/** 中文抬頭點陣圖：24 點高，每列 3 bytes（ESC * 39 格式，180 dpi） */
export interface RasterBand { columns: Uint8Array }

function ascii(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    out.push(c >= 0x20 && c < 0x7f ? c : 0x3f) // 非 ASCII → '?'（理論上去到呢度前已經擋咗）
  }
  return out
}

export function encodeEscp(items: PrintItem[], rasters: Record<string, RasterBand> = {}): Uint8Array {
  const out: number[] = [ESC, 0x40, ESC, 0x55, 0x01] // ESC @ 重設；ESC U 1 單向（對位準啲）
  const rows = new Map<number, PrintItem[]>()
  for (const it of items) {
    const y = Math.max(0, Math.round((it.y / MM_PER_INCH) * 180))
    rows.set(y, [...(rows.get(y) ?? []), it])
  }
  let cur = 0
  for (const y of Array.from(rows.keys()).sort((a, b) => a - b)) {
    let d = y - cur
    while (d > 0) { const n = Math.min(255, d); out.push(ESC, 0x4a, n); d -= n }
    cur = y
    for (const it of rows.get(y)!.sort((a, b) => a.x - b.x)) {
      const h = Math.max(0, Math.round((it.x / MM_PER_INCH) * 60))
      out.push(ESC, 0x24, h & 0xff, (h >> 8) & 0xff)
      const r = rasters[it.key]
      if (r) {
        const n = r.columns.length / 3
        out.push(ESC, 0x2a, 39, n & 0xff, (n >> 8) & 0xff, ...Array.from(r.columns))
      } else {
        out.push(ESC, it.cpi === 12 ? 0x4d : 0x50) // ESC M = 12 cpi；ESC P = 10 cpi
        out.push(...ascii(it.text))
      }
      out.push(0x0d)
    }
  }
  out.push(0x0c)
  return Uint8Array.from(out)
}

export const TEXT_COL_MM = MM_PER_INCH / 10
export const TEXT_ROW_MM = MM_PER_INCH / 6

export function encodeText(items: PrintItem[]): Uint8Array {
  const grid = new Map<number, string[]>()
  for (const it of items) {
    const row = Math.max(0, Math.round(it.y / TEXT_ROW_MM))
    const col = Math.max(0, Math.round(it.x / TEXT_COL_MM))
    const line = grid.get(row) ?? []
    const chars = ascii(it.text)
    chars.forEach((c, i) => { line[col + i] = String.fromCharCode(c) })
    grid.set(row, line)
  }
  const maxRow = Math.max(-1, ...Array.from(grid.keys()))
  let s = ''
  for (let r = 0; r <= maxRow; r++) {
    const line = grid.get(r) ?? []
    s += Array.from({ length: line.length }, (_, i) => line[i] ?? ' ').join('').trimEnd() + '\r\n'
  }
  return textBytes(s)
}

// ---------- 測試頁 ----------

/** 第 1 步：純文字（任何模式都應該印到） */
export function plainTestPage(): Uint8Array {
  const lines = [
    'CHEQUE PRINTER TEST 1 - PLAIN TEXT',
    '1234567890123456789012345678901234567890',
    'IF THIS IS READABLE, THE USB CONNECTION WORKS.',
  ]
  return textBytes(lines.join('\r\n') + '\r\n')
}

/** 第 2 步：ESC/P 格仔（每 10mm 一個 +）。印到整齊格仔 = 打印機識 ESC/P；印出亂碼 = 唔識，用 TEXT 模式 */
export function escpGridPage(paper: { w: number; h: number }): Uint8Array {
  const items: PrintItem[] = []
  for (let y = 0; y <= paper.h; y += 10) {
    for (let x = 0; x <= paper.w - 10; x += 10) items.push({ key: `g${x}_${y}`, x, y, text: x === 0 ? `+${y}` : '+', cpi: 10 })
  }
  items.push({ key: 'title', x: 20, y: 4, text: 'CHEQUE PRINTER TEST 2 - ESC/P GRID 10MM', cpi: 12 })
  return encodeEscp(items)
}

function textBytes(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c === 0x0d || c === 0x0a) out.push(c)
    else out.push(c >= 0x20 && c < 0x7f ? c : 0x3f)
  }
  out.push(0x0c)
  return Uint8Array.from(out)
}

/**
 * 單色點陣（最多 24 點高）→ ESC * 39 列資料。每列 3 bytes，最高位 = 最上面嗰點。
 * 瀏覽器用 canvas 以 180 dpi 畫中文抬頭，再用呢個轉。
 */
export function bitmapToBand(width: number, height: number, black: (x: number, y: number) => boolean): RasterBand {
  const cols = new Uint8Array(width * 3)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < Math.min(24, height); y++) {
      if (black(x, y)) cols[x * 3 + (y >> 3)] |= 0x80 >> (y & 7)
    }
  }
  return { columns: cols }
}
