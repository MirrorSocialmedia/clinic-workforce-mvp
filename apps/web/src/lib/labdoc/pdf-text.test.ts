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
