/**
 * ★ cwm-labdoc P2 — E2E 1：§5.1 讀單全鏈（真 DB cwm_labdoc_p2 ＋ 真 W 3105 隔離實例 labdoc-extract）
 *
 * 跑法: cd apps/web && npx tsx scripts/e2e-labdoc-p2.ts
 *   env 由 .env.local 讀（DATABASE_URL／JWT_SECRET／LAB_DOC_*／WA_INBOX_LABDOC_URL／
 *   INTERNAL_LLM_*／APRICOT_CRON_KEY）— 唔需要起 dev server（in-process handlers，
 *   跟 P1 e2e 做法）；W 側係真 HTTP 打 127.0.0.1:3105（3105 = 隔離 W 實例，LLM 打 30000 vLLM）。
 *
 * 決斷：
 *   A  sweep 守門（403 無 key／403 錯 key／200 正確）
 *   B  上傳 2 頁 PDF（fixture sample-text.pdf）→ 201（D9 預設拆頁 → **兩張單**共用同一 file）
 *   C  背景讀單轮询 → 終態（每張）：
 *        NEEDS_REVIEW = E2E 成功（W 已啟用，mock/LLM 讀到）
 *        EXTRACT_FAILED = W 邊界（503 NOT_ENABLED 等 → 'upstream'，attempts=3）
 *   T9 兩張單同 INVOICE_NO（fixture 兩頁同 docNo + 同 lab）→ **一張 NEEDS_REVIEW、一張 DUPLICATE**
 *      （duplicateOfId 指向贏家；partial unique index 要 labId 非 null — fixture 已加 lab 行）
 *   D  retry route（EXTRACT_FAILED → 202 → 再 3 次 → EXTRACT_FAILED；唔無限；非 failed → 400）
 *   E  sweep（T17：EXTRACT_FAILED 唔會自動再試；stale/UPLOADED 計數正確）
 *   F  收結零殘留（doc×2/lines/pages/file 清走；e2e user 保留俾重跑，flag 註明）
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

const NON_TERMINAL = ['UPLOADED', 'EXTRACTING']

async function pollDocs(docIds: string[], rounds = 90): Promise<Record<string, any>> {
  let docs: Record<string, any> = {}
  for (let i = 0; i < rounds; i++) {
    await sleep(5000)
    docs = {}
    for (const id of docIds) docs[id] = await prisma.labDocument.findUnique({ where: { id } })
    if (docIds.every((id) => docs[id] && !NON_TERMINAL.includes(docs[id].status))) break
  }
  return docs
}

function docSummary(d: any): Record<string, unknown> {
  return {
    status: d?.status,
    attempts: d?.extractAttempts,
    extractError: d?.extractError,
    extractSource: d?.extractSource,
    docNo: d?.docNo,
    labId: d?.labId,
    labBasis: d?.labBasis,
    providerId: d?.providerId,
    clinicId: d?.clinicId,
    total: d?.total,
    readIssues: d?.readIssues,
    duplicateOfId: d?.duplicateOfId,
    hasExtractedJson: d?.extractedJson !== null,
  }
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

  // ── B. 上傳（2 頁 PDF fixture → D9 拆頁 → 兩張單）─────────
  const pdf = readFileSync(join(process.cwd(), 'test/fixtures/labdoc/sample-text.pdf'))
  const key = `e2e-p2-${Date.now()}`
  const fd = new FormData()
  fd.append('files', new File([pdf], 'sample-text.pdf', { type: 'application/pdf' }))
  fd.append('kind', 'INVOICE')
  fd.append('idempotencyKey', key)
  const up = await uploadPOST(new NextRequest('http://x/api/lab-docs/upload', { method: 'POST', headers: { cookie: `session=${token}` }, body: fd }))
  const upBody = (await up.json()) as any
  const docIds: string[] = ((upBody.documents ?? []) as any[]).map((d) => d.id).filter(Boolean)
  ev.steps.B_upload = { status: up.status, docIds, error: upBody.error }
  if (up.status !== 201 || docIds.length < 2) {
    throw new Error(`upload 失敗或 D9 拆頁出唔到兩張單（status=${up.status}, docs=${docIds.length}）：${JSON.stringify(upBody)}`)
  }
  const [docIdA, docIdB] = docIds

  // ── C. 轮询終態（每張；W 503 時 ~60-70s：3 次 × 30s backoff；真 LLM 慢啲）────
  const t0 = Date.now()
  let docs = await pollDocs(docIds)
  ev.steps.C_terminal = {
    waitedMs: Date.now() - t0,
    docs: Object.fromEntries(docIds.map((id) => [id, docSummary(docs[id])])),
    lines: Object.fromEntries(await Promise.all(docIds.map(async (id) => [id, await prisma.labDocumentLine.count({ where: { documentId: id } })]))),
  }

  // ── T9. 同 INVOICE_NO 並發：一張 NEEDS_REVIEW、一張 DUPLICATE ──────────────
  // 判定容錯：EXTRACT_FAILED（W 邊界/LLM 失敗）時 T9 唔適用（記 'not-applicable'，唔算 fail）。
  const statuses = docIds.map((id) => docs[id]?.status)
  const failed = statuses.filter((s) => s === 'EXTRACT_FAILED').length
  let t9: Record<string, unknown>
  if (failed > 0) {
    t9 = { statuses, result: 'not-applicable (EXTRACT_FAILED)', pass: false }
  } else {
    const nr = statuses.filter((s) => s === 'NEEDS_REVIEW').length
    const dup = statuses.filter((s) => s === 'DUPLICATE').length
    const dupId = docIds[statuses.indexOf('DUPLICATE')]
    const dupDoc = docs[dupId]
    t9 = {
      statuses,
      dupDocId: dupId,
      duplicateOfId: dupDoc?.duplicateOfId,
      duplicateOfIsSister: docIds.includes(dupDoc?.duplicateOfId) && dupDoc?.duplicateOfId !== dupId,
      labIds: docIds.map((id) => docs[id]?.labId),
      docNos: docIds.map((id) => docs[id]?.docNo),
      pass: nr === 1 && dup === 1 && docIds.includes(dupDoc?.duplicateOfId) && dupDoc?.duplicateOfId !== dupId,
    }
  }
  ev.steps.T9 = t9

  // ── D. retry（EXTRACT_FAILED 先有意味）──────────────────
  for (const id of docIds) {
    const d = docs[id]
    if (d?.status !== 'EXTRACT_FAILED') continue
    const r1 = await retryPOST(req(`http://x/api/lab-docs/${id}/retry`, 'POST', token) as any, { params: { id } } as any)
    const retried = await pollDocs([id], 90)
    const d2 = retried[id]
    ev.steps[`D_retry_${id.slice(-6)}`] = {
      first: { status: r1.status, body: await r1.json().catch(() => null) },
      terminal: { status: d2?.status, attempts: d2?.extractAttempts, extractError: d2?.extractError },
      pass: r1.status === 202 && d2?.status === 'EXTRACT_FAILED' && (d2?.extractAttempts ?? 0) === (d?.extractAttempts ?? 0) + 3,
    }
  }
  // 非 EXTRACT_FAILED 狀態 retry → 400（另開一張 NEEDS_REVIEW doc 測試）
  {
    const d400 = await prisma.labDocument.create({
      data: { kind: 'INVOICE', status: 'NEEDS_REVIEW', uploadedBy: user.id },
    })
    const r2 = await retryPOST(req(`http://x/api/lab-docs/${d400.id}/retry`, 'POST', token) as any, { params: { id: d400.id } } as any)
    await prisma.labDocument.delete({ where: { id: d400.id } }).catch(() => undefined)
    ev.steps.D_retry_nonfailed_400 = { status: r2.status, pass: r2.status === 400 }
  }

  // ── E. sweep（T17 真 DB：EXTRACT_FAILED 唔會自動再試）────────
  const cronNow = new Date(Date.now() + 10 * 60_000).toISOString()
  const sw = await sweepPOST(req('http://x/api/internal/labdoc-sweep', 'POST', null, undefined, { 'x-cron-key': cronKey || 'x', 'x-cron-now': cronNow }))
  const swBody = sw.status === 200 ? await sw.json() : (await sw.text())
  const afterSweep = await Promise.all(docIds.map((id) => prisma.labDocument.findUnique({ where: { id }, select: { status: true, extractAttempts: true } })))
  ev.steps.E_sweep = { status: sw.status, body: swBody, docAfterSweep: afterSweep }

  // ── F. 收結零殘留 ────────────────────────────────────────
  // F0. drain 晒在途 background extraction（避開 cleanup 同寫入 race）
  const { __drainLabDocExtractions } = await import('../src/lib/labdoc/extract')
  await __drainLabDocExtractions()
  const docsFinal = Object.fromEntries(await Promise.all(docIds.map(async (id) => [id, await prisma.labDocument.findUnique({ where: { id }, select: { status: true, extractAttempts: true, extractError: true } })])))
  ev.steps.E2_final = docsFinal
  const failedAfter = docIds.filter((id) => docsFinal[id]?.status === 'EXTRACT_FAILED')
  if (failedAfter.length > 0) {
    const sw2 = await sweepPOST(req('http://x/api/internal/labdoc-sweep', 'POST', null, undefined, { 'x-cron-key': cronKey || 'x', 'x-cron-now': cronNow }))
    const sw2Body = sw2.status === 200 ? await sw2.json() : (await sw2.text())
    const after2 = await Promise.all(docIds.map((id) => prisma.labDocument.findUnique({ where: { id }, select: { status: true, extractAttempts: true } })))
    ev.steps.E2_sweep_failed_not_retried = { status: sw2.status, body: sw2Body, docAfterSweep: after2 }
  }

  // 兩張單共用同一 LabFile（D9 拆頁）— page 行逐 doc 刪，file 只有當全庫 page 引用歸零先刪
  await prisma.labDocumentLine.deleteMany({ where: { documentId: { in: docIds } } })
  const allPages = await prisma.labDocumentPage.findMany({ where: { documentId: { in: docIds } }, select: { documentId: true, fileId: true } })
  const fileIds = [...new Set(allPages.map((p) => p.fileId))]
  let fileRemoved = 0
  if (fileIds.length > 0) {
    const refCounts = await prisma.labDocumentPage.groupBy({ by: ['fileId'], where: { fileId: { in: fileIds } }, _count: { fileId: true } })
    for (const fid of fileIds) {
      const refs = refCounts.find((g) => g.fileId === fid)?._count.fileId ?? 0
      const ours = allPages.filter((p) => p.fileId === fid).length
      if (refs === ours) {
        await prisma.labDocumentPage.deleteMany({ where: { fileId: fid } })
        await prisma.labFile.delete({ where: { id: fid } }).catch(() => undefined)
        fileRemoved++
      }
    }
  }
  await prisma.labDocumentPage.deleteMany({ where: { documentId: { in: docIds } } })
  for (const id of docIds) await prisma.labDocument.delete({ where: { id } })
  ev.steps.F_cleanup = { fileRemoved, dbDocsLeft: await prisma.labDocument.count() }

  // ── 總結 ─────────────────────────────────────────────────
  ev.pass = {
    A: ev.steps.A_sweep_gate.noKey === 403 && ev.steps.A_sweep_gate.wrongKey === 403,
    B: ev.steps.B_upload.status === 201,
    C_terminalNeedsReviewOrFailed: statuses.every((s) => s === 'NEEDS_REVIEW' || s === 'EXTRACT_FAILED' || s === 'DUPLICATE'),
    T9: t9.pass === true,
    E_sweep: sw.status === 200,
    F_zeroResidue: ev.steps.F_cleanup.dbDocsLeft === 0,
  }

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
