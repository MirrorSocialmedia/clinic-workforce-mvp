/**
 * cwm-labdoc：pdfjs 載入（process.ts 渲染＋extract.ts 抽文字共用）
 *
 * Node 冇 Web Worker → pdfjs 用「fake worker」，會再 `import(workerSrc)` 載 pdf.worker.mjs。
 * Next standalone 打包（nft）只跟字面 import 路徑，呢個動態 import 跟唔到 → 生產 image 冇 worker 檔
 * （2026-10-10 生產：Setting up fake worker failed: Cannot find module …/pdf.worker.mjs）。
 * 做法：自己用字面路徑先 import worker（nft 會帶埋入 image），放入 globalThis.pdfjsWorker —
 * pdfjs 見到 main-thread WorkerMessageHandler 就唔再 import workerSrc。
 */
let cached: Promise<any> | null = null

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
