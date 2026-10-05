/**
 * cwm-labdoc P1 — 上傳處理（§4.2）
 *
 * 相片（JPEG/PNG，前端已 canvas 轉 JPEG 去 EXIF）：
 *   sharp 出顯示圖（長邊 1600）＋縮圖（長邊 320），按 EXIF orientation 轉正
 * PDF（原檔唔改）：
 *   magic %PDF-；拒絕加密 PDF；頁數 ≤ 30；pdfjs-dist 逐頁抽文字
 *   （hasTextLayer = 每頁文字 ≥ 20 字）＋ @napi-rs/canvas 渲染顯示圖＋縮圖
 */
export const DISPLAY_MAX_EDGE = 1600
export const THUMB_MAX_EDGE = 320
export const PDF_MAX_PAGES = 30
const PAGE_TEXT_LAYER_THRESHOLD = 20 // §4.2：每頁文字 ≥ 20 字先算有文字層

export class LabDocProcessError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number = 415,
  ) {
    super(message)
    this.name = 'LabDocProcessError'
  }
}

// ------------------------------------------------------------------
// magic bytes
// ------------------------------------------------------------------
export function isJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
}
export function isPdf(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-'
}

// ------------------------------------------------------------------
// 相片處理
// ------------------------------------------------------------------
export interface ProcessedImage {
  mime: 'image/jpeg'
  original: Buffer // 上傳嘅原 bytes（sha256 用呢個）
  display: Buffer
  thumb: Buffer
  pageCount: 1
  hasTextLayer: false
  pages: Array<{ pageNo: number; display: Buffer; thumb: Buffer; textChars: number; width: number; height: number }>
}

export async function processImage(raw: Buffer): Promise<ProcessedImage> {
  // webpackIgnore：sharp 係 native module（.node 二進位）— 畀 Node runtime 原生載入，
  // 同 labdoc-render-check.mjs / alpine CI 同一條路徑（webpack bundle 唔到 .node）
  const sharp = (await import(/* webpackIgnore: true */ 'sharp')).default
  try {
    // rotate() 無參 = 按 EXIF orientation 轉正（前端已去 EXIF 都無害）
    const normalized = await sharp(raw, { failOn: 'error' }).rotate().toBuffer()
    const meta = await sharp(normalized).metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    if (!w || !h) throw new Error('bad image dimensions')

    const display = await sharp(normalized)
      .resize({ width: DISPLAY_MAX_EDGE, height: DISPLAY_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer()
    const thumb = await sharp(normalized)
      .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()

    const dm = await sharp(display).metadata()
    return {
      mime: 'image/jpeg',
      original: raw,
      display,
      thumb,
      pageCount: 1,
      hasTextLayer: false,
      pages: [
        {
          pageNo: 1,
          display,
          thumb,
          textChars: 0,
          width: dm.width ?? w,
          height: dm.height ?? h,
        },
      ],
    }
  } catch (e: any) {
    if (e instanceof LabDocProcessError) throw e
    throw new LabDocProcessError('圖片解碼失敗（唔係有效 JPEG/PNG）：' + (e?.message ?? e), 415)
  }
}

// ------------------------------------------------------------------
// PDF 處理
// ------------------------------------------------------------------
export interface PdfPageOut {
  pageNo: number
  display: Buffer
  thumb: Buffer
  textChars: number
  width: number // 渲染後 pixel
  height: number
}
export interface ProcessedPdf {
  mime: 'application/pdf'
  original: Buffer
  pages: PdfPageOut[]
  pageCount: number
  hasTextLayer: boolean
}

export async function processPdf(raw: Buffer): Promise<ProcessedPdf> {
  // webpackIgnore：pdfjs + @napi-rs/canvas（native）— runtime 原生載入，同 alpine CI 同路徑
  const pdfjs = await import(/* webpackIgnore: true */ 'pdfjs-dist/legacy/build/pdf.mjs')
  const { createCanvas } = await import(/* webpackIgnore: true */ '@napi-rs/canvas')

  let doc: any
  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(raw),
      useSystemFonts: true,
    })
    doc = await loadingTask.promise
  } catch (e: any) {
    // pdfjs 加密 PDF：PasswordException（名可能喺 e.name / e.__proto__.name）
    const name = e?.name ?? ''
    if (name === 'PasswordException' || /password/i.test(String(e?.message ?? ''))) {
      throw new LabDocProcessError('加密 PDF 唔接受（§4.2：拒絕加密 PDF）', 415)
    }
    throw new LabDocProcessError('PDF 解析失敗：' + (e?.message ?? e), 415)
  }

  try {
    if (doc.isEncrypted) throw new LabDocProcessError('加密 PDF 唔接受（§4.2：拒絕加密 PDF）', 415)
    if (doc.numPages > PDF_MAX_PAGES) {
      throw new LabDocProcessError(`PDF 頁數超過上限 ${PDF_MAX_PAGES} 頁（呢份有 ${doc.numPages} 頁）`, 413)
    }

    const pages: PdfPageOut[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const baseVp = page.getViewport({ scale: 1 })

      // 文字層
      let textChars = 0
      try {
        const tc = await page.getTextContent()
        textChars = tc.items.map((it: any) => String(it.str ?? '')).join('').trim().length
      } catch {
        textChars = 0
      }

      // 顯示圖：長邊 ≤ 1600（cap scale 4 防極小頁爆記憶體）
      const dispScale = Math.min(DISPLAY_MAX_EDGE / Math.max(baseVp.width, baseVp.height), 4)
      const dispVp = page.getViewport({ scale: dispScale })
      const dispCanvas = createCanvas(Math.max(1, Math.floor(dispVp.width)), Math.max(1, Math.floor(dispVp.height)))
      await page.render({ canvasContext: dispCanvas.getContext('2d'), viewport: dispVp }).promise
      const display = dispCanvas.toBuffer('image/jpeg', 0.85)

      // 縮圖：長邊 ≤ 320（唔放大）
      const thumbScale = Math.min(THUMB_MAX_EDGE / Math.max(baseVp.width, baseVp.height), 1)
      const thumbVp = page.getViewport({ scale: thumbScale })
      const thumbCanvas = createCanvas(Math.max(1, Math.floor(thumbVp.width)), Math.max(1, Math.floor(thumbVp.height)))
      await page.render({ canvasContext: thumbCanvas.getContext('2d'), viewport: thumbVp }).promise
      const thumb = thumbCanvas.toBuffer('image/jpeg', 0.8)

      pages.push({
        pageNo: i,
        display,
        thumb,
        textChars,
        width: Math.floor(dispVp.width),
        height: Math.floor(dispVp.height),
      })
    }
    return {
      mime: 'application/pdf',
      original: raw,
      pages,
      pageCount: doc.numPages,
      hasTextLayer: pages.every((p) => p.textChars >= PAGE_TEXT_LAYER_THRESHOLD),
    }
  } finally {
    try {
      await doc.destroy()
    } catch {
      /* ignore */
    }
  }
}

// ------------------------------------------------------------------
// 入口：magic bytes 分派
// ------------------------------------------------------------------
export type ProcessedFile = (ProcessedImage & { type: 'image' }) | (ProcessedPdf & { type: 'pdf' })

export async function processUploadFile(raw: Buffer): Promise<ProcessedFile> {
  if (isPdf(raw)) return { ...(await processPdf(raw)), type: 'pdf' }
  if (isJpeg(raw)) return { ...(await processImage(raw)), type: 'image' }
  throw new LabDocProcessError('檔案類型唔接受（要 JPEG 相片或 PDF）', 415)
}

