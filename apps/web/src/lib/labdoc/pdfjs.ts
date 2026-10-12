/**
 * cwm-labdoc：pdfjs 載入（process.ts 渲染＋extract.ts 抽文字共用）
 *
 * Node 冇 Web Worker → pdfjs 用「fake worker」，會再 `import(workerSrc)` 載 pdf.worker.mjs。
 * Next standalone 打包（nft）只跟字面 import 路徑，呢個動態 import 跟唔到 → 生產 image 冇 worker 檔
 * （2026-10-10 生產：Setting up fake worker failed: Cannot find module …/pdf.worker.mjs）。
 * 做法：自己用字面路徑先 import worker（nft 會帶埋入 image），放入 globalThis.pdfjsWorker —
 * pdfjs 見到 main-thread WorkerMessageHandler 就唔再 import workerSrc。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

let cached: Promise<any> | null = null
let docOpts: Record<string, unknown> | null = null

/**
 * ★ 2026-10-11：getDocument 共用參數 — cMap 同標準字型資料夾。
 * 冇 cMapUrl：用預設 CMap（例如 UniCNS-UCS2-H）而冇嵌入字型嘅中文字（Modern Dental 月結單收件人格）
 * 會解唔到 → 抽文字成段冇咗、渲染出亂碼（pdfjs：「Ensure that the `cMapUrl` API parameter is provided」）。
 * Dockerfile 保留咗 pdfjs-dist/cmaps 同 standard_fonts；呢度搵返實際路徑（standalone /app 或者 dev apps/web）。
 */
export function pdfjsDocOptions(): Record<string, unknown> {
  if (docOpts) return docOpts
  const candidates = [
    join(process.cwd(), 'node_modules', 'pdfjs-dist'),
    join(process.cwd(), 'apps', 'web', 'node_modules', 'pdfjs-dist'),
  ]
  const dir = candidates.find((d) => existsSync(join(d, 'cmaps')))
  docOpts = dir
    ? {
        cMapUrl: join(dir, 'cmaps') + '/',
        cMapPacked: true,
        standardFontDataUrl: join(dir, 'standard_fonts') + '/',
      }
    : {}
  if (!dir) console.error('[labdoc/pdfjs] 搵唔到 pdfjs-dist/cmaps — 中文 CMap 字型會讀唔到')
  return docOpts
}

export function loadPdfjs(): Promise<any> {
  cached ??= (async () => {
    // webpackIgnore：runtime 原生載入（同 alpine CI 同路徑）
    // @ts-expect-error — pdf.worker.mjs 冇型別宣告（只係交俾 pdfjs 用）
    const worker = await import(/* webpackIgnore: true */ 'pdfjs-dist/legacy/build/pdf.worker.mjs')
    ;(globalThis as any).pdfjsWorker = worker
    return import(/* webpackIgnore: true */ 'pdfjs-dist/legacy/build/pdf.mjs')
  })().catch((e) => {
    cached = null // 載入失敗唔好 cache 住，下次再試
    throw e
  })
  return cached
}
