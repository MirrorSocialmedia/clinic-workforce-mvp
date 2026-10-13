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
 *
 * ★ 2026-10-13（同日再改）：有表格格線就按「格」砌（pdfTableText）。
 *   合併儲存格（單號／醫生／病人／Total Amount／Notes 跨幾行、垂直置中）之前會排喺組中間，
 *   組第一行冇單號 → prompt 9b「單號空白沿用上一個」喺逐頁讀時冇得沿用（第 2 頁開頭嗰行 $4,000 成日漏讀）。
 *   而家：每個字放入佢所屬嘅格（上下左右最近嘅格線），同一格多行合埋一格；
 *   格按「上邊線」分行 → 合併格同組第一行同一行。冇格線（或者格太大，例如得外框）嘅字照舊按 baseline 分行。
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

/** 冇格線嘅字：按 baseline 分行，回傳 [y, 行文字] */
function baselineRows(items: PdfTextItem[]): Array<{ y: number; text: string }> {
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
      return { y: r.y, text: line.replace(/[ \t]+/g, ' ').trim() }
    })
    .filter((r) => r.text.length > 0)
}

export function pdfItemsToText(items: PdfTextItem[]): string {
  return baselineRows(items)
    .sort((a, b) => b.y - a.y) // PDF y 向上 → 大嘅喺上面
    .map((r) => r.text)
    .join('\n')
}

// ------------------------------------------------------------------
// 表格格線
// ------------------------------------------------------------------
/** 水平線：y、x1..x2；垂直線：x、y1..y2（PDF 座標，y 向上） */
export interface HLine { y: number; x1: number; x2: number }
export interface VLine { x: number; y1: number; y2: number }
export interface Rulings { h: HLine[]; v: VLine[] }

const THIN = 2.5 // 線粗（pt）上限
const MIN_LEN = 5
/** 一格最多幾多條 baseline 先當係「格」（超過 = 外框之類，唔當格） */
const MAX_CELL_BASELINES = 6

type Mat = [number, number, number, number, number, number]
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
]
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/**
 * 由 pdfjs operator list 抽表格線（pdfjs ≥ 5 constructPath：args = [drawOp, [pathData], minMax]；
 * pathData：0 moveTo x y、1 lineTo x y、2 curveTo 6 個數、3 quadraticCurveTo 4 個數、4 closePath）。
 * 幼長方形（填色）同直線（stroke）都計。跟 save／restore／transform 計 CTM。
 */
export function extractRulings(opList: { fnArray: number[]; argsArray: any[] }, OPS: Record<string, number>): Rulings {
  const h: HLine[] = []
  const v: VLine[] = []
  let ctm: Mat = [1, 0, 0, 1, 0, 0]
  // 虛線（牙位象限十字之類）唔係格線 → 唔計；setDash 跟 save／restore
  let dashed = false
  const stack: Array<{ ctm: Mat; dashed: boolean }> = []
  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter((x) => x !== undefined))
  const strokes = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter((x) => x !== undefined))
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i]
    const args = opList.argsArray[i]
    if (fn === OPS.save) stack.push({ ctm, dashed })
    else if (fn === OPS.restore) {
      const st = stack.pop()
      ctm = st?.ctm ?? [1, 0, 0, 1, 0, 0]
      dashed = st?.dashed ?? false
    } else if (fn === OPS.setDash) dashed = Array.isArray(args?.[0]) && args[0].some((d: unknown) => Number(d) > 0)
    else if (fn === OPS.transform && Array.isArray(args) && args.length === 6) ctm = mul(args.map(Number) as Mat, ctm)
    else if (fn === OPS.constructPath && Array.isArray(args)) {
      const drawOp = args[0]
      const isFill = fills.has(drawOp)
      const isStroke = strokes.has(drawOp)
      if (!isFill && !isStroke) continue
      const data: ArrayLike<number> | undefined = Array.isArray(args[1]) ? args[1][0] : undefined
      if (!data || typeof data.length !== 'number') continue
      // 拆 subpath（每個 moveTo 開新一段）
      const subs: Array<Array<[number, number]>> = []
      let cur: Array<[number, number]> = []
      for (let k = 0; k < data.length; ) {
        const op = data[k]
        if (op === 0 || op === 1) {
          const p = apply(ctm, Number(data[k + 1]), Number(data[k + 2]))
          if (op === 0) { if (cur.length) subs.push(cur); cur = [p] } else cur.push(p)
          k += 3
        } else if (op === 2) k += 7
        else if (op === 3) k += 5
        else if (op === 4) k += 1
        else break // 唔識嘅格式 → 停（唔好亂估）
      }
      if (cur.length) subs.push(cur)
      for (const pts of subs) {
        if (isFill && pts.length >= 3) {
          const xs = pts.map((p) => p[0])
          const ys = pts.map((p) => p[1])
          const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys)
          if (y2 - y1 <= THIN && x2 - x1 >= MIN_LEN) h.push({ y: (y1 + y2) / 2, x1, x2 })
          else if (x2 - x1 <= THIN && y2 - y1 >= MIN_LEN) v.push({ x: (x1 + x2) / 2, y1, y2 })
        }
        if (isStroke && !dashed) {
          for (let k = 1; k < pts.length; k++) {
            const [ax, ay] = pts[k - 1]
            const [bx, by] = pts[k]
            if (Math.abs(ay - by) < 0.5 && Math.abs(ax - bx) >= MIN_LEN) h.push({ y: (ay + by) / 2, x1: Math.min(ax, bx), x2: Math.max(ax, bx) })
            else if (Math.abs(ax - bx) < 0.5 && Math.abs(ay - by) >= MIN_LEN) v.push({ x: (ax + bx) / 2, y1: Math.min(ay, by), y2: Math.max(ay, by) })
          }
        }
      }
    }
  }
  return { h, v }
}

const isCjk = (ch: string | undefined) => !!ch && /[　-鿿＀-￯]/.test(ch)

/**
 * 按格砌文字：每個字搵包住佢嘅格（上下左右最近嘅格線）；同一格多行合埋；
 * 格按上邊線分行（合併格 = 組第一行）、行內按左邊線排，用「 | 」分格。
 * 搵唔到格、或者格入面超過 MAX_CELL_BASELINES 條 baseline（外框）嘅字 → 照 baseline 分行。
 * 冇任何格線 → 等於 pdfItemsToText。
 */
export function pdfTableText(items: PdfTextItem[], rulings: Rulings): string {
  if (rulings.h.length < 2 || rulings.v.length < 2) return pdfItemsToText(items)
  const TOL = 0.5
  interface Cell { key: string; top: number; bottom: number; left: number; items: Array<{ x: number; y: number; h: number; s: string }> }
  const cells = new Map<string, Cell>()
  const loose: PdfTextItem[] = []
  for (const it of items) {
    const s = String(it.str ?? '')
    if (!s.trim()) continue
    const t = it.transform ?? [1, 0, 0, 1, 0, 0]
    const x = Number(t[4]) || 0
    const y = Number(t[5]) || 0
    const hgt = Math.abs(Number(t[3])) || Math.abs(Number(it.height)) || 10
    const w = Number(it.width) > 0 ? Number(it.width) : s.length * hgt * 0.5
    const cx = x + w / 2
    const cy = y + hgt * 0.35 // 字中間（baseline 之上）
    let top: number | null = null
    let bottom: number | null = null
    for (const l of rulings.h) {
      if (cx < l.x1 - TOL || cx > l.x2 + TOL) continue
      if (l.y > cy && (top === null || l.y < top)) top = l.y
      if (l.y < cy && (bottom === null || l.y > bottom)) bottom = l.y
    }
    // 跨頁表格：上一頁延續落嚟嘅合併格（單號／醫生／病人）頁頂冇上邊線；表尾延續落下一頁冇下邊線
    // → 上面冇線遮住呢個 x = 格一直去到表頂：用上面最高嗰條橫線（唔理 x 範圍）；下面同理用最低嗰條。
    //   同一格嘅幾行字就會得到同一個上／下邊，唔會拆開；而且同組第一行（表頂嗰行）對齊。
    if (top === null) for (const l of rulings.h) if (l.y > cy && (top === null || l.y > top)) top = l.y
    if (bottom === null) for (const l of rulings.h) if (l.y < cy && (bottom === null || l.y < bottom)) bottom = l.y
    let left: number | null = null
    let right: number | null = null
    for (const l of rulings.v) {
      if (cy < l.y1 - TOL || cy > l.y2 + TOL) continue
      if (l.x < cx && (left === null || l.x > left)) left = l.x
      if (l.x > cx && (right === null || l.x < right)) right = l.x
    }
    if (top === null || bottom === null || left === null || right === null) {
      loose.push(it)
      continue
    }
    const key = `${top.toFixed(1)}|${bottom.toFixed(1)}|${left.toFixed(1)}|${right.toFixed(1)}`
    let c = cells.get(key)
    if (!c) {
      c = { key, top, bottom, left, items: [] }
      cells.set(key, c)
    }
    c.items.push({ x, y, h: hgt, s })
  }

  const rows = new Map<string, { top: number; cells: Array<{ left: number; text: string }> }>()
  for (const c of cells.values()) {
    // 一格入面嘅 baseline 太多 = 唔係表格格（外框）→ 退返 baseline 分行
    const lines = baselineRows(c.items.map((i) => ({ str: i.s, transform: [i.h, 0, 0, i.h, i.x, i.y] })))
    if (lines.length > MAX_CELL_BASELINES) {
      for (const i of c.items) loose.push({ str: i.s, transform: [i.h, 0, 0, i.h, i.x, i.y] })
      continue
    }
    const text = lines
      .sort((a, b) => b.y - a.y)
      .map((l) => l.text.replace(/ \| /g, ' '))
      .reduce((acc, l) => (acc === '' ? l : acc + (isCjk(acc.slice(-1)) || isCjk(l[0]) ? '' : ' ') + l), '')
    const rk = c.top.toFixed(1)
    let row = rows.get(rk)
    if (!row) {
      row = { top: c.top, cells: [] }
      rows.set(rk, row)
    }
    row.cells.push({ left: c.left, text })
  }
  const out: Array<{ y: number; text: string }> = [...rows.values()].map((r) => ({
    y: r.top,
    text: r.cells.sort((a, b) => a.left - b.left).map((c) => c.text).join(' | '),
  }))
  out.push(...baselineRows(loose))
  return out
    .filter((r) => r.text.length > 0)
    .sort((a, b) => b.y - a.y)
    .map((r) => r.text)
    .join('\n')
}

// ------------------------------------------------------------------
// 睇唔到嘅字（裁切走／隱藏）
// ------------------------------------------------------------------
/**
 * ★ 2026-10-13：WPS 跨頁合併格會喺兩頁都畫同一段字，再用裁切遮住其中一頁 — 文字層照樣抽到
 *   （禾呈月結單：第 1 頁底頁邊有第 2 頁嗰張單嘅單號＋$4,000，畫面睇唔到）→ AI 可能計兩次。
 * 做法：頁面渲染咗之後，睇每粒字嘅位置有冇真係畫咗嘢（範圍入面深淺有差）；一片均勻 = 睇唔到 → 唔要。
 * `sample(x, y, w, h)` 回傳嗰個範圍（viewport pixel）嘅 [最淺, 最深] 亮度（0–255）；呢度只做判斷（純函數）。
 */
export function visibleTextItems(
  items: PdfTextItem[],
  toViewport: (x: number, y: number) => [number, number],
  sample: (x: number, y: number, w: number, h: number) => [number, number] | null,
): PdfTextItem[] {
  return items.filter((it) => {
    const s = String(it.str ?? '')
    if (!s.trim()) return true
    const t = it.transform ?? [1, 0, 0, 1, 0, 0]
    const x = Number(t[4]) || 0
    const y = Number(t[5]) || 0
    const hgt = Math.abs(Number(t[3])) || Math.abs(Number(it.height)) || 10
    const w = Number(it.width) > 0 ? Number(it.width) : s.length * hgt * 0.5
    const [ax, ay] = toViewport(x, y + hgt)
    const [bx, by] = toViewport(x + w, y - hgt * 0.2)
    const rx = Math.min(ax, bx), ry = Math.min(ay, by)
    const rw = Math.abs(bx - ax), rh = Math.abs(by - ay)
    if (rw < 1 || rh < 1) return true
    const r = sample(rx, ry, rw, rh)
    if (!r) return true // 出界／讀唔到 → 保守保留
    return r[0] - r[1] >= 40 // 有字畫咗出嚟（有明暗對比）
  })
}
