/**
 * ★ 2026-10-13：重新渲染已上傳 PDF 嘅顯示圖＋縮圖（修正 JPEG 質素 bug 之前上傳嘅都係糊圖）
 *
 * 只重寫每頁 display／thumb 圖（加密檔，同一個 key 覆寫；tmp → rename 原子寫），
 * **唔改數據庫、唔郁原檔、唔重新讀單**。頁數同 DB 唔夾 → 跳過嗰個檔（唔寫）。
 *
 * 用法（生產機，要同 app 一樣嘅 DATABASE_URL、LAB_DOC_DIR、LAB_DOC_ENC_KEY）：
 *   npx tsx scripts/labdoc-rerender-pdf-pages.mts            # 試跑：只列出會處理幾多個檔／頁
 *   npx tsx scripts/labdoc-rerender-pdf-pages.mts --apply    # 真係重寫
 *   … --apply --since 2026-10-01                              # 只處理某日之後上傳嘅
 * 🔴 零原文：log 只記 fileId＋頁數＋結果。
 */
const apply = process.argv.includes('--apply')
const sinceIdx = process.argv.indexOf('--since')
const since = sinceIdx > 0 ? new Date(`${process.argv[sinceIdx + 1]}T00:00:00Z`) : null
if (since && Number.isNaN(since.getTime())) {
  console.error('--since 要 YYYY-MM-DD')
  process.exit(1)
}

const { prisma } = await import('../src/lib/prisma')
const { readEncrypted, saveEncrypted, buildPageKey } = await import('../src/lib/labdoc/storage')
const { processPdf } = await import('../src/lib/labdoc/process')

const files = await prisma.labFile.findMany({
  where: { mime: 'application/pdf', purgedAt: null, ...(since ? { uploadedAt: { gte: since } } : {}) },
  select: { id: true, storageKey: true, uploadedAt: true, pageCount: true },
  orderBy: { uploadedAt: 'asc' },
})
const pages = files.reduce((a, f) => a + f.pageCount, 0)
console.log(`${apply ? '重寫' : '試跑'}：${files.length} 個 PDF，共 ${pages} 頁${since ? `（${since.toISOString().slice(0, 10)} 之後上傳）` : ''}`)
if (!apply) {
  console.log('加 --apply 先會真係重寫')
  await prisma.$disconnect()
  process.exit(0)
}

let ok = 0
let skipped = 0
let failed = 0
for (const f of files) {
  try {
    const out = await processPdf(await readEncrypted(f.storageKey))
    if (out.pages.length !== f.pageCount) {
      console.warn(`跳過 ${f.id}：渲染出 ${out.pages.length} 頁，DB 記 ${f.pageCount} 頁`)
      skipped++
      continue
    }
    for (const p of out.pages) {
      await saveEncrypted(buildPageKey(f.id, f.uploadedAt, p.pageNo, 'display'), p.display)
      await saveEncrypted(buildPageKey(f.id, f.uploadedAt, p.pageNo, 'thumb'), p.thumb)
    }
    ok++
  } catch (e) {
    console.error(`失敗 ${f.id}：${String((e as Error)?.message ?? e).slice(0, 200)}`)
    failed++
  }
}
console.log(`完成：重寫 ${ok}、跳過 ${skipped}、失敗 ${failed}`)
await prisma.$disconnect()
