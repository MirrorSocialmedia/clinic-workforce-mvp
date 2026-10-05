/**
 * ★ cwm-labdoc P2 — E2E 1：§5.1 讀單全鏈（真 DB cwm_labdoc_p2 ＋ 真 W 3100 labdoc-extract）
 *
 * 跑法: cd apps/web && npx tsx scripts/e2e-labdoc-p2.ts
 *   env 由 .env.local 讀（DATABASE_URL／JWT_SECRET／LAB_DOC_*／WA_INBOX_LABDOC_URL／
 *   INTERNAL_LLM_*／APRICOT_CRON_KEY）— 唔需要起 dev server（in-process handlers，
 *   跟 P1 e2e 做法）；W 側係真 HTTP 打 127.0.0.1:3100。
 *
 * 決斷：
 *   A  sweep 守門（403 無 key／403 錯 key／200 正確）
 *   B  上傳 2 頁 PDF（fixture sample-text.pdf）→ 201 UPLOADED（回應唔等讀單）
 *   C  背景讀單轮询 → 終態：
 *        NEEDS_REVIEW = E2E 成功（W 已啟用，mock/LLM 讀到）
 *        EXTRACT_FAILED = W 邊界（503 NOT_ENABLED 等 → 'upstream'，attempts=3）
 *   D  retry route（EXTRACT_FAILED → 202 → 再 3 次 → EXTRACT_FAILED；唔無限）
 *   E  sweep（T17：EXTRACT_FAILED 唔會自動再試；stale/UPLOADED 計數正確）
 *   F  收結零殘留（doc/lines/pages/file 清走；e2e user 保留俾重跑，flag 註明）
 *
 * 證據：stdout JSON + 寫 logs/labdoc-p2/e2e-<ts>.json（/tmp 唔可靠 — 鐵律 8）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'

// ─── env（.env.local）──────────────────────────────────────
function loadEnvLocal(path: string): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
loadEnvLocal(join(process.cwd(), '.env.local'))

const prisma = new PrismaClient()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ev: Record<string, unknown> = { at: new Date().toISOString(), steps: {} as Record<string, unknown> }

function req(url: string, method: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  const h: Record<string, string> = { ...headers }
  if (token) h.cookie = `session=${token}` // requireAuth 讀 cookie 'session'（唔係 Bearer）
  return new NextRequest(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function main(): Promise<void> {
  const { createToken } = await import('../src/lib/auth')
  const { POST: uploadPOST } = await import('../src/app/api/lab-docs/upload/route')
  const { POST: retryPOST } = await import('../src/app/api/lab-docs/[id]/retry/route')
  const { POST: sweepPOST } = await import('../src/app/api/internal/labdoc-sweep/route')

  // ── e2e user（idempotent）────────────────────────────────
  const outDir = join(process.cwd(), '../../../logs/labdoc-p2')
  mkdirSync(outDir, { recursive: true })
  const bcrypt = (await import('bcryptjs')).default as unknown as { hashSync: (s: string, n: number) => string }
  const phone = '99990001'
  let user = await prisma.user.findUnique({ where: { phone } })
  if (!user) {
    user = await prisma.user.create({
      data: { name: 'E2E CTO', phone, password: bcrypt.hashSync('e2e-p2-pw', 10), role: 'OWNER' },
    })
    ev.user = 'created'
  } else {
    ev.user = 'reused'
  }
  const token = createToken({ userId: user.id, role: 'OWNER', clinics: [], tokenVersion: user.tokenVersion })

  // ── A. sweep 守門 ────────────────────────────────────────
  const cronKey = process.env.APRICOT_CRON_KEY || ''
  const a1 = await sweepPOST(req('http://x/api/internal/labdoc-sweep', 'POST', null))
  const a2 = await sweepPOST(req('http://x/api/internal/labdoc-sweep', 'POST', null, undefined, { 'x-cron-key': 'wrong-key-123' }))
  const a3 = cronKey ? await sweepPOST(req('http://x/api/internal/labdoc-sweep', 'POST', null, undefined, { 'x-cron-key': cronKey })) : null
  ev.steps.A_sweep_gate = {
    noKey: a1.status,
    wrongKey: a2.status,
    okKey: a3 ? { status: a3.status, body: await a3.json() } : 'APRICOT_CRON_KEY 未設',
  }

  // ── B. 上傳（2 頁 PDF fixture）──────────────────────────
  const pdf = readFileSync(join(process.cwd(), 'test/fixtures/labdoc/sample-text.pdf'))
  const key = `e2e-p2-${Date.now()}`
  const fd = new FormData()
  fd.append('files', new File([pdf], 'sample-text.pdf', { type: 'application/pdf' }))
  fd.append('kind', 'INVOICE')
  fd.append('idempotencyKey', key)
  const up = await uploadPOST(new NextRequest('http://x/api/lab-docs/upload', { method: 'POST', headers: { cookie: `session=${token}` }, body: fd }))
  const upBody = (await up.json()) as any
  ev.steps.B_upload = { status: up.status, docId: upBody.documents?.[0]?.id, statusField: upBody.documents?.[0]?.status, error: upBody.error }
  const docId: string | undefined = upBody.documents?.[0]?.id
  if (!docId) throw new Error(`upload 失敗：${JSON.stringify(upBody)}`)

  // ── C. 轮询終態（W 503 時 ~60-70s：3 次 × 30s backoff；W mock 時快）────────
  const t0 = Date.now()
  let doc: any = null
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    doc = await prisma.labDocument.findUnique({ where: { id: docId } })
    if (!['UPLOADED', 'EXTRACTING'].includes(doc.status)) break
  }
  ev.steps.C_terminal = {
    waitedMs: Date.now() - t0,
    status: doc?.status,
    attempts: doc?.extractAttempts,
    extractError: doc?.extractError,
    extractSource: doc?.extractSource,
    docNo: doc?.docNo,
    total: doc?.total,
    readIssues: doc?.readIssues,
    hasExtractedJson: doc?.extractedJson !== null,
    lines: (await prisma.labDocumentLine.count({ where: { documentId: docId } })),
  }

  // ── D. retry（EXTRACT_FAILED 先有意味）──────────────────
  if (doc?.status === 'EXTRACT_FAILED') {
    const r1 = await retryPOST(req(`http://x/api/lab-docs/${docId}/retry`, 'POST', token) as any, { params: { id: docId } } as any)
    ev.steps.D_retry = { status: r1.status, body: await r1.json() }
    let doc2: any = null
    for (let i = 0; i < 60; i++) {
      await sleep(5000)
      doc2 = await prisma.labDocument.findUnique({ where: { id: docId } })
      if (!['UPLOADED', 'EXTRACTING'].includes(doc2.status)) break
    }
    ev.steps.D_retry_terminal = { status: doc2?.status, attempts: doc2?.extractAttempts, extractError: doc2?.extractError }
    // 非 EXTRACT_FAILED 狀態 → 400（另開一张 NEEDS_REVIEW doc — 同一张 retry 完仲係 EXTRACT_FAILED，唔代表 400）
    const d400 = await prisma.labDocument.create({
      data: { kind: 'INVOICE', status: 'NEEDS_REVIEW', uploadedBy: user.id },
    })
    const r2 = await retryPOST(req(`http://x/api/lab-docs/${d400.id}/retry`, 'POST', token) as any, { params: { id: d400.id } } as any)
    await prisma.labDocument.delete({ where: { id: d400.id } }).catch(() => undefined)
    ev.steps.D_retry_nonfailed_400 = r2.status
  }

  // ── E. sweep（T17 真 DB：EXTRACT_FAILED 唔會自動再試）────────────────
  const cronNow = new Date(Date.now() + 10 * 60_000).toISOString()
  const sw = await sweepPOST(req('http://x/api/internal/labdoc-sweep', 'POST', null, undefined, { 'x-cron-key': cronKey || 'x', 'x-cron-now': cronNow }))
  const swBody = sw.status === 200 ? await sw.json() : (await sw.text())
  const docAfterSweep = await prisma.labDocument.findUnique({ where: { id: docId }, select: { status: true, extractAttempts: true } })
  ev.steps.E_sweep = { status: sw.status, body: swBody, docAfterSweep }

  // ── F. 收結零殘留 ────────────────────────────────────────
  // ── F0. drain 晒在途 background extraction（避開 cleanup 同書記 race）──
  const { __drainLabDocExtractions } = await import('../src/lib/labdoc/extract')
  await __drainLabDocExtractions()
  const docFinal = await prisma.labDocument.findUnique({ where: { id: docId }, select: { status: true, extractAttempts: true, extractError: true } })
  ev.steps.E2_final = docFinal
  if (docFinal?.status === 'EXTRACT_FAILED') {
    const sw2 = await sweepPOST(req('http://x/api/internal/labdoc-sweep', 'POST', null, undefined, { 'x-cron-key': cronKey || 'x', 'x-cron-now': cronNow }))
    const sw2Body = sw2.status === 200 ? await sw2.json() : (await sw2.text())
    const docAfterSweep2 = await prisma.labDocument.findUnique({ where: { id: docId }, select: { status: true, extractAttempts: true } })
    ev.steps.E2_sweep_failed_not_retried = { status: sw2.status, body: sw2Body, docAfterSweep: docAfterSweep2 }
  }

  await prisma.labDocumentLine.deleteMany({ where: { documentId: docId } })
  await prisma.labDocumentPage.deleteMany({ where: { documentId: docId } })
  const docFull = await prisma.labDocument.findUnique({ where: { id: docId }, include: { pages: { select: { fileId: true } } } })
  const fileIds = [...new Set((docFull?.pages ?? []).map((p: any) => p.fileId))]
  const fileDocs = fileIds.length ? await prisma.labDocumentPage.groupBy({ by: ['fileId'], where: { fileId: { in: fileIds } }, _count: { fileId: true } }) : []
  const removable = fileIds.filter((fid) => !fileDocs.some((g: any) => g.fileId === fid && g._count.fileId > (docFull?.pages ?? []).filter((p: any) => p.fileId === fid).length))
  await prisma.labDocumentPage.deleteMany({ where: { documentId: docId } })
  await prisma.labDocument.delete({ where: { id: docId } })
  await prisma.labFile.deleteMany({ where: { id: { in: removable } } })
  ev.steps.F_cleanup = { lines: 0, fileRemoved: removable.length, dbDocsLeft: await prisma.labDocument.count() }

  const out = join(process.cwd(), '../../../logs/labdoc-p2/e2e-result.json')
  mkdirSync(join(process.cwd(), '../../../logs/labdoc-p2'), { recursive: true })
  writeFileSync(out, JSON.stringify(ev, null, 2))
  console.log(JSON.stringify(ev, null, 2))
}

main()
  .catch((e) => {
    console.error('E2E FAILED:', e)
    writeFileSync(join(process.cwd(), '../../../logs/labdoc-p2/e2e-result.json'), JSON.stringify({ ...ev, fatal: String(e?.message ?? e) }, null, 2))
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
