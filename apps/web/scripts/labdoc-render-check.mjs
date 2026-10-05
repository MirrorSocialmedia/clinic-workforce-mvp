#!/usr/bin/env node
/**
 * labdoc-render-check.mjs — cwm-labdoc P1 第一步：node:22-alpine 渲染證明
 *
 * 施工單 §17 P1：node:22-alpine image 試裝 sharp / pdfjs-dist / @napi-rs/canvas
 * 並渲染 test/fixtures/labdoc/*.pdf。本機 dev 無 docker 權 → 呢個 script 由
 * GitHub Actions job `labdoc-alpine-render`（真 node:22-alpine container）執行；
 * 本機 glibc 都可以直接跑做 pre-flight。
 *
 * 斷言：
 *   1. sharp native binding 可 load 並 resize（musl/glibc 都要過）
 *   2. 每個 fixture PDF 所有頁都可以 render 成 JPEG（@napi-rs/canvas），且有非白像素
 *   3. sample-text.pdf 每頁文字層 ≥20 字（pdfjs getTextContent 抽得到）
 *   4. sample-scan.pdf 文字層 = 0 字（模擬掃描件，冇文字層）
 *
 * Usage: node scripts/labdoc-render-check.mjs [fixtures-dir]
 *   fixtures-dir 預設 = test/fixtures/labdoc
 * Exit 0 = PASS；非 0 = FAIL（stderr 列出失敗項）
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const FIXTURES_DIR = path.resolve(
  process.argv[2] || path.join(import.meta.dirname, '..', 'test', 'fixtures', 'labdoc'),
)

const fails = []
const ok = (name) => console.log('  PASS  ' + name)
const bad = (name, detail) => {
  fails.push(name + (detail ? ' — ' + detail : ''))
  console.error('  FAIL  ' + name + (detail ? ' — ' + detail : ''))
}

// ---------------------------------------------------------------
// 1. sharp self-test（native binding load + resize）
// ---------------------------------------------------------------
console.log('== sharp self-test ==')
{
  try {
    const sharp = (await import('sharp')).default
    // 建一個 60x40 漸變圖 → resize 100x100 → 驗證尺寸
    const raw = Buffer.alloc(60 * 40 * 3)
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 60; x++) {
        raw[(y * 60 + x) * 3 + 0] = (x * 4) & 0xff
        raw[(y * 60 + x) * 3 + 1] = (y * 6) & 0xff
        raw[(y * 60 + x) * 3 + 2] = 200
      }
    }
    const out = await sharp(raw, { raw: { width: 60, height: 40, channels: 3 } })
      .jpeg({ quality: 80 })
      .resize(100, 100)
      .toBuffer()
    const meta = await sharp(out).metadata()
    if (meta.width === 100 && meta.height === 100) ok('sharp resize 60x40→100x100 jpeg')
    else bad('sharp resize', `got ${meta.width}x${meta.height}`)
  } catch (e) {
    bad('sharp load/resize', e.message)
  }
}

// ---------------------------------------------------------------
// 2/3/4. PDF 渲染 + 文字層
// ---------------------------------------------------------------
console.log('== pdfjs + @napi-rs/canvas render ==')
let pdfjs, createCanvas
try {
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  ;({ createCanvas } = await import('@napi-rs/canvas'))
} catch (e) {
  console.error('  FATAL import: ' + e.message)
  process.exit(2)
}

async function renderPdf(pdfPath) {
  const buf = new Uint8Array(fs.readFileSync(pdfPath))
  // useSystemFonts：Node 環境用系統/內置字體，免 standardFontDataUrl
  const loadingTask = pdfjs.getDocument({ data: buf, isEvalSupported: false, useSystemFonts: true })
  const doc = await loadingTask.promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    const text = tc.items.map((it) => it.str).join('')
    const viewport = page.getViewport({ scale: 1.5 })
    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height))
    const ctx = canvas.getContext('2d')
    await page.render({ canvasContext: ctx, viewport }).promise
    // 非白像素計數（每 16 像素抽一個樣本）
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let nonWhite = 0
    for (let p = 0; p < d.length; p += 16) {
      if (d[p] < 250 || d[p + 1] < 250 || d[p + 2] < 250) nonWhite++
    }
    pages.push({ i, textChars: text.length, nonWhite })
  }
  await loadingTask.destroy()
  return pages
}

const pdfs = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.pdf')).sort()
if (pdfs.length === 0) {
  console.error('  FATAL no fixture PDFs in ' + FIXTURES_DIR)
  process.exit(2)
}
for (const f of pdfs) {
  const name = 'render ' + f
  try {
    const pages = await renderPdf(path.join(FIXTURES_DIR, f))
    for (const p of pages) {
      if (p.nonWhite === 0) {
        bad(name, `page ${p.i} 渲染後全白（非白樣本=0）`)
      } else {
        console.log(`  info  ${f} page ${p.i}: ${p.textChars} text chars, ${p.nonWhite} non-white samples`)
      }
    }
    if (f === 'sample-text.pdf') {
      for (const p of pages) {
        if (p.textChars >= 20) ok(`${f} page ${p.i} 文字層 ${p.textChars} 字 (≥20)`)
        else bad(`${f} page ${p.i}`, `文字層只 ${p.textChars} 字 (<20)`)
      }
    }
    if (f === 'sample-scan.pdf') {
      const total = pages.reduce((s, p) => s + p.textChars, 0)
      if (total === 0) ok(`${f} 文字層 = 0 字（scan 模擬正確）`)
      else bad(f, `應該冇文字層，抽到 ${total} 字`)
    }
    if (!fails.some((x) => x.startsWith(name))) ok(name)
  } catch (e) {
    bad(name, e.message)
  }
}

// ---------------------------------------------------------------
console.log('')
if (fails.length) {
  console.error('ALPINE RENDER CHECK: FAIL (' + fails.length + ')')
  process.exit(1)
}
console.log('ALPINE RENDER CHECK: PASS — sharp + pdfjs-dist + @napi-rs/canvas 全部可安裝並渲染 fixture')
