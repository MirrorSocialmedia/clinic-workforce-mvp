// ★ 2026-10-13：PDF 文字層按位置砌行（禾呈 WPS 表格月結單 — 之前成頁黐埋一行）
//   跑法: TZ=UTC npx tsx --test src/lib/labdoc/pdf-text.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pdfItemsToText, type PdfTextItem } from './pdf-text'

// x, y（PDF 座標 y 向上）、字高 h、闊 w
const I = (str: string, x: number, y: number, w = str.length * 5, h = 10): PdfTextItem => ({ str, transform: [h, 0, 0, h, x, y], width: w, height: h })

test('同一行按 x 排、唔同格用「 | 」分；由上至下分行', () => {
  const t = pdfItemsToText([
    I('HK$440.00', 400, 700), I('INV-001', 20, 700), I('Crown', 200, 700),
    I('INV-002', 20, 680), I('HK$320.00', 400, 680),
  ])
  assert.equal(t, 'INV-001 | Crown | HK$440.00\nINV-002 | HK$320.00')
})

test('同一格入面分開幾個 item（貼住／隔少少）→ 接返／加空格，唔加「|」', () => {
  const t = pdfItemsToText([I('HK$', 150, 500, 15), I('4,000.00', 165, 500, 40), I('Total:', 20, 500, 30), I('Amount', 60, 500, 30)])
  assert.equal(t, 'Total: Amount | HK$4,000.00')
})

test('baseline 有少少高低（半個字高以內）都當同一行', () => {
  const t = pdfItemsToText([I('A', 10, 300), I('B', 100, 303), I('C', 200, 297)])
  assert.equal(t, 'A | B | C')
})

test('空白 item 唔要；冇 transform／width 都唔死', () => {
  const t = pdfItemsToText([{ str: '   ' }, { str: 'X' }, I('', 5, 5), { str: 'Y', transform: [10, 0, 0, 10, 50, 0] }])
  assert.equal(t, 'X | Y')
})

test('冇字 → 空字串', () => {
  assert.equal(pdfItemsToText([]), '')
})

// ★ 2026-10-13：@napi-rs/canvas JPEG 質素係 0–100 — 之前寫 0.85（≈1%）令所有 PDF 顯示圖／VISION 讀單圖糊晒
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JPEG_QUALITY_DISPLAY, JPEG_QUALITY_THUMB } from './process'
test('PDF 顯示圖／縮圖 JPEG 質素用 0–100 刻度（唔係 0–1）', () => {
  assert.ok(JPEG_QUALITY_DISPLAY >= 70 && JPEG_QUALITY_DISPLAY <= 100)
  assert.ok(JPEG_QUALITY_THUMB >= 60 && JPEG_QUALITY_THUMB <= 100)
  const src = readFileSync(join(__dirname, 'process.ts'), 'utf8')
  assert.equal(/toBuffer\(\s*['"]image\/jpeg['"]\s*,\s*0?\.\d/.test(src), false, 'toBuffer jpeg 唔可以用 0.x 質素')
})

// ★ 2026-10-13：表格格線砌文字（合併格同組第一行同一行）＋跨頁＋隱藏字
import { pdfTableText, extractRulings, visibleTextItems, type Rulings } from './pdf-text'

// 一個兩組嘅表：欄 x = 0|60|120|200|260；第一組（INV-001）合併格跨兩行（y 700..660），品項兩行（700..680、680..660）
const GRID: Rulings = {
  h: [
    { y: 720, x1: 0, x2: 260 }, // 表頭上
    { y: 700, x1: 0, x2: 260 }, // 表頭下 = 第一組上
    { y: 680, x1: 120, x2: 260 }, // 第一組入面：只喺品項欄（合併格冇呢條）
    { y: 660, x1: 0, x2: 260 }, // 第一組下
  ],
  v: [0, 60, 120, 200, 260].map((x) => ({ x, y1: 660, y2: 720 })),
}

test('表格：合併格（垂直置中）同組第一行同一行；第二行品項自己一行', () => {
  const t = pdfTableText([
    I('INV#', 5, 705), I('Dr.', 65, 705), I('Item', 125, 705), I('Amount', 205, 705),
    I('INV-001', 5, 677), I('Dr A', 65, 677), // 合併格：垂直置中（喺第二行品項嘅高度）
    I('Crown', 125, 685), I('HK$440.00', 205, 685, 50),
    I('Model', 125, 665), I('HK$0.00', 205, 665, 40),
  ], GRID)
  assert.equal(t, 'INV# | Dr. | Item | Amount\nINV-001 | Dr A | Crown | HK$440.00\nModel | HK$0.00')
})

test('表格：同一格多行字合返一格（中文直接接、英文加空格）', () => {
  const t = pdfTableText([
    I('種植杆卡+基', 125, 690, 60), I('臺修復', 125, 682, 30),
    I('Dr.Tse', 65, 690, 30), I('Fai', 65, 682, 15),
  ], GRID)
  assert.equal(t, 'Dr.Tse Fai | 種植杆卡+基臺修復')
})

test('跨頁：頁頂合併格冇上邊線 → 伸到表頂，同第一行品項對齊', () => {
  const cont: Rulings = {
    h: [{ y: 800, x1: 120, x2: 260 }, { y: 780, x1: 120, x2: 260 }, { y: 760, x1: 0, x2: 260 }],
    v: [0, 60, 120, 200, 260].map((x) => ({ x, y1: 760, y2: 800 })),
  }
  const t = pdfTableText([
    I('INV-002', 5, 778), I('Implant', 125, 788), I('HK$4,000.00', 205, 788, 50), I('Abutment', 125, 768), I('HK$0.00', 205, 768, 40),
  ], cont)
  assert.equal(t, 'INV-002 | Implant | HK$4,000.00\nAbutment | HK$0.00')
})

test('表格：冇格線／格線唔夠 → 同 pdfItemsToText 一樣', () => {
  const items = [I('A', 10, 300), I('B', 100, 300)]
  assert.equal(pdfTableText(items, { h: [], v: [] }), pdfItemsToText(items))
  assert.equal(pdfTableText(items, { h: [{ y: 400, x1: 0, x2: 500 }], v: [] }), pdfItemsToText(items))
})

test('表格：得外框（一格入面好多行）→ 唔當格，照 baseline 分行', () => {
  const box: Rulings = { h: [{ y: 800, x1: 0, x2: 500 }, { y: 0, x1: 0, x2: 500 }], v: [{ x: 0, y1: 0, y2: 800 }, { x: 500, y1: 0, y2: 800 }] }
  const items = Array.from({ length: 8 }, (_, i) => [I(`L${i}`, 10, 700 - i * 20), I(`R${i}`, 300, 700 - i * 20)]).flat()
  assert.equal(pdfTableText(items, box), pdfItemsToText(items))
})

test('extractRulings：幼長方形填色＝線；跟 transform 翻 y；虛線唔計；粗長方形唔計', () => {
  const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, eoFill: 23, fill: 22, stroke: 20, setDash: 30 } as Record<string, number>
  const rect = (x1: number, y1: number, x2: number, y2: number) => [0, x1, y1, 1, x2, y1, 1, x2, y2, 1, x1, y2, 4]
  const r = extractRulings({
    fnArray: [OPS.save, OPS.transform, OPS.constructPath, OPS.constructPath, OPS.constructPath, OPS.setDash, OPS.constructPath, OPS.restore],
    argsArray: [
      null,
      [1, 0, 0, -1, 0, 842], // y 向下 → 翻返
      [OPS.eoFill, [rect(20, 100, 500, 100.8)], null], // 水平幼條：y = 842-100.4
      [OPS.eoFill, [rect(20, 100, 20.8, 300)], null], // 垂直幼條
      [OPS.eoFill, [rect(20, 400, 200, 450)], null], // 粗長方形（底色）→ 唔計
      [[3, 2], 0],
      [OPS.stroke, [[0, 30, 500, 1, 300, 500]], null], // 虛線 → 唔計
      null,
    ],
  }, OPS)
  assert.equal(r.h.length, 1); assert.ok(Math.abs(r.h[0].y - 741.6) < 0.01); assert.deepEqual([r.h[0].x1, r.h[0].x2], [20, 500])
  assert.equal(r.v.length, 1); assert.ok(Math.abs(r.v[0].x - 20.4) < 0.01)
})

test('visibleTextItems：範圍一片均勻（裁切走）→ 剔走；有明暗 → 留；讀唔到 → 保守保留', () => {
  const items = [I('seen', 10, 100), I('ghost', 10, 5), I('edge', 10, 900)]
  const vis = visibleTextItems(items, (x, y) => [x, 842 - y], (x, y) => (y > 800 ? [255, 255] : y > 830 ? null : [255, 20]))
  assert.deepEqual(vis.map((i) => i.str), ['seen', 'edge'])
})
