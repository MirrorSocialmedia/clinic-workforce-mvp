/**
 * ★ 2026-10-13：PDF 文字層 → 按位置砌返「一行一行」嘅文字（交俾讀單 AI，TEXT 模式）
 *
 * 之前 extract.ts 直接 `items.map(str).join('')`：WPS／Excel 出嘅表格 PDF（例：禾呈月結單）
 * 成頁變一行、格同格黐埋（"…NotesINV-xxxx Dr.xxx…"），AI 要估邊個數屬邊行 → 讀半個鐘最後 llm_error；
 * 而且冇換行 → 「月結單 > 40 行就逐頁讀」嘅判斷以為得 1 行，5 頁一次過送。
 *
 * 做法（純函數）：
 *   - 按 baseline y 分行（同一行 = y 差 ≤ 字高一半），由上至下
 *   - 行內按 x 排；間隔 > 字高 1.2 倍 → 「 | 」（唔同格）；細啲 → 空格；貼住 → 直接接
 *   - 空白項目唔要
 * 唔改字、唔估欄位意思 — 只係保留版面。
 */

export interface PdfTextItem {
  str?: string
  /** [a, b, c, d, e, f]：e = x、f = y（PDF 座標，y 向上） */
  transform?: number[]
  width?: number
  height?: number
}

interface Part { x: number; end: number; s: string }
interface Row { y: number; h: number; parts: Part[] }

export function pdfItemsToText(items: PdfTextItem[]): string {
  const rows: Row[] = []
  for (const it of items) {
    const s = String(it.str ?? '')
    if (!s.trim()) continue
    const t = it.transform ?? [1, 0, 0, 1, 0, 0]
    const x = Number(t[4]) || 0
    const y = Number(t[5]) || 0
    const h = Math.abs(Number(t[3])) || Math.abs(Number(it.height)) || 10
    const w = Number(it.width) > 0 ? Number(it.width) : s.length * h * 0.5
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(1, Math.min(r.h, h) * 0.5))
    if (!row) {
      row = { y, h, parts: [] }
      rows.push(row)
    }
    row.parts.push({ x, end: x + w, s })
  }
  rows.sort((a, b) => b.y - a.y) // PDF y 向上 → 大嘅喺上面
  return rows
    .map((r) => {
      const parts = r.parts.sort((a, b) => a.x - b.x)
      let line = ''
      let prevEnd: number | null = null
      for (const p of parts) {
        if (prevEnd !== null) {
          const gap = p.x - prevEnd
          if (gap > r.h * 1.2) line += ' | '
          else if (gap > r.h * 0.15 && !line.endsWith(' ') && !p.s.startsWith(' ')) line += ' '
        }
        line += p.s
        prevEnd = Math.max(prevEnd ?? p.end, p.end)
      }
      return line.replace(/[ \t]+/g, ' ').trim()
    })
    .filter((l) => l.length > 0)
    .join('\n')
}
