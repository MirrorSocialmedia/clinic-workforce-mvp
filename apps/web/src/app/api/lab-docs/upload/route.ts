// ★ cwm-labdoc P1：POST /api/lab-docs/upload — Lab 單據上傳（§4.2、B15、B16）
// multipart：files[]、kind、labId?、statementMonth?、splitPdfPages?（P1 接受但忽略）、
//            idempotencyKey、force?（只限 lab_statement）
// → { documents: [{id, status}] }（1 檔 = 1 單據，P1 保守；拆頁／合併係 P2）
//
// 限制：單檔 ≤ 15MB；一次最多 20 個檔；總數 ≤ 60MB → 超過 413（中文訊息）
// sha256 重複（未作廢單據）→ 409 { duplicateOf }；force=true（lab_statement）先准再上傳
// 冪等：idempotencyKey + requestHash（LabDocWriteLog；同 BookingWriteLog 做法）
// 存底：加密寫碟先，DB 單 transaction 後；中途死 → 孤兒檔由 purge sweep 24h 後清
export const dynamic = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { LabDocProcessError, processUploadFile, type ProcessedFile } from '@/lib/labdoc/process'
import { assertEncryptionConfigured } from '@/lib/labdoc/crypto'
import { buildPageKey, buildStorageKey, saveEncrypted } from '@/lib/labdoc/storage'
import { labdocAudit } from '@/lib/labdoc/audit'
import { runLabDocExtract } from '@/lib/labdoc/extract'

const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_FILES = 20
const MAX_TOTAL_BYTES = 60 * 1024 * 1024
const STALE_IN_PROGRESS_MS = 10 * 60 * 1000 // B15：殘留 IN_PROGRESS 10 分鐘當過期
const RETENTION_MS = 7 * 365 * 24 * 3600 * 1000 // B8：7 年

interface RawFile {
  name: string
  buf: Buffer
  sha256: string
}
interface PreparedFile {
  raw: RawFile
  out: ProcessedFile
  fileId: string
  storageKey: string
  pagesJson: Array<{ page: number; displayKey: string; thumbKey: string; width: number; height: number; textChars: number }>
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  // §10.3：所有 labdoc route 用 resolveClinicScope — 有 lab 權限 = 全集團（B16）
  // ⚠️ 唔可用 requireAuth 的 scope（EMPLOYEE 經 perm 放行時係 'self' — 對 labdoc 太窄）
  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return NextResponse.json({ error: '冇任何診所範圍，唔可以上傳' }, { status: 403 })
  }

  // 加密 key 未設 → 503（唔准靜靜存明文）
  try {
    assertEncryptionConfigured()
  } catch {
    return NextResponse.json(
      { error: '存底系統未設定（LAB_DOC_ENC_KEY 缺失），請聯絡技術人員' },
      { status: 503 },
    )
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: '上傳格式錯誤（要 multipart/form-data）' }, { status: 400 })
  }

  const kind = (form.get('kind') as string) || ''
  if (kind !== 'INVOICE' && kind !== 'STATEMENT') {
    return NextResponse.json({ error: '單據類型要係 INVOICE 或 STATEMENT' }, { status: 400 })
  }
  const labIdRaw = (form.get('labId') as string) || ''
  const statementMonth = (form.get('statementMonth') as string) || ''
  const force = form.get('force') === 'true' || form.get('force') === '1'
  const idempotencyKey = (form.get('idempotencyKey') as string) || ''
  // ★ cwm-labdoc P2 §7.11（D9）：拆頁 — invoice 預設每頁一張（splitPdfPages 唔傳 / true / 1）；
  //   「全部一張」= splitPdfPages=false（讀完之前可以用 merge 改返）。STATEMENT 永遠一張。
  const splitPdfPagesRaw = (form.get('splitPdfPages') as string) || ''
  const splitPdfPages =
    kind === 'INVOICE' && (splitPdfPagesRaw === '' || splitPdfPagesRaw === 'true' || splitPdfPagesRaw === '1')

  if (force && !(perms ?? []).includes('lab_statement')) {
    return NextResponse.json({ error: '強制重傳需要 lab_statement 權限' }, { status: 403 })
  }
  if (!idempotencyKey || idempotencyKey.length > 128 || !/^[a-zA-Z0-9:_-]+$/.test(idempotencyKey)) {
    return NextResponse.json({ error: 'idempotencyKey 缺失或格式錯誤' }, { status: 400 })
  }
  if (kind === 'STATEMENT' && statementMonth && !/^\d{4}-\d{2}$/.test(statementMonth)) {
    return NextResponse.json({ error: '月結單月份格式要 YYYY-MM' }, { status: 400 })
  }

  // labId 驗證（有傳先查）
  let labId: string | null = null
  if (labIdRaw) {
    const lab = await prisma.lab.findUnique({ where: { id: labIdRaw }, select: { id: true, isActive: true } })
    if (!lab) return NextResponse.json({ error: '選嘅 Lab 唔存在' }, { status: 400 })
    if (!lab.isActive) return NextResponse.json({ error: '選嘅 Lab 已停用' }, { status: 400 })
    labId = lab.id
  }

  // —— 讀檔 + 大小限制 ——
  const fileEntries = form.getAll('files').filter((f): f is File => f instanceof File)
  if (fileEntries.length === 0) {
    return NextResponse.json({ error: '冇檔案' }, { status: 400 })
  }
  if (fileEntries.length > MAX_FILES) {
    return NextResponse.json(
      { error: `一次最多上傳 ${MAX_FILES} 個檔（呢次要 ${fileEntries.length} 個）` },
      { status: 413 },
    )
  }
  const sizes = fileEntries.map((f) => f.size)
  const totalBytes = sizes.reduce((a, b) => a + b, 0)
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: '全部檔案合共超過 60MB 上限' }, { status: 413 })
  }
  for (let i = 0; i < fileEntries.length; i++) {
    if (sizes[i] === 0) {
      return NextResponse.json({ error: `第 ${i + 1} 個檔係空檔` }, { status: 400 })
    }
    if (sizes[i] > MAX_FILE_BYTES) {
      return NextResponse.json({ error: `第 ${i + 1} 個檔超過 15MB 上限` }, { status: 413 })
    }
  }

  // —— 讀入記憶體 + sha256 + batch 內重複偵測（先於昂貴處理）——
  const rawFiles: RawFile[] = []
  for (let i = 0; i < fileEntries.length; i++) {
    const f = fileEntries[i]
    const buf = Buffer.from(await f.arrayBuffer())
    const sha256 = createHash('sha256').update(buf).digest('hex')
    if (rawFiles.some((r) => r.sha256 === sha256)) {
      return NextResponse.json({ error: `第 ${i + 1} 個檔同 batch 內其他檔完全相同` }, { status: 409 })
    }
    rawFiles.push({
      name: (f.name || '').replace(/.*[\\/]/, '').slice(0, 80), // 去路徑，前 80 字
      buf,
      sha256,
    })
  }

  // —— 冪等（B15）：requestHash = sha256(要旨)；WriteLog IN_PROGRESS → DONE ——
  // ★ 順序重要：冪等檢查一定要喺重複偵測前 — 同 key 重試（撳兩下／network retry）
  //   要回 200 replay，唔係 409 duplicate（首次上傳完成後，own 檔案自然命中 sha256 重複）。
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        kind,
        labId,
        statementMonth,
        force,
        files: rawFiles.map((r) => ({ name: r.name, sha256: r.sha256, size: r.buf.length })),
      }),
    )
    .digest('hex')

  const prior = await prisma.labDocWriteLog.findUnique({ where: { idempotencyKey } })
  if (prior) {
    if (prior.status === 'IN_PROGRESS') {
      if (Date.now() - prior.createdAt.getTime() <= STALE_IN_PROGRESS_MS) {
        return NextResponse.json({ error: '同一上傳正在處理中，請幾秒後再試' }, { status: 409 })
      }
      // stale（>10min）→ 落面 upsert 覆寫重試（最保守：唔猜佢成功咗冇）
    } else if (prior.status === 'DONE') {
      if (prior.requestHash === requestHash) {
        const resp = (prior.responseJson as any) ?? { documents: [] }
        return NextResponse.json({ ...resp, replayed: true }, { status: 200 })
      }
      return NextResponse.json(
        { error: 'idempotencyKey 已用过但內容唔同 — 請用新 key' },
        { status: 409 },
      )
    } else {
      return NextResponse.json({ error: 'idempotencyKey 狀態異常 — 請用新 key' }, { status: 409 })
    }
  }
  // 先落 IN_PROGRESS（並發錨 — 任何失敗都留 IN_PROGRESS，10 分鐘後 stale 可重試）
  await prisma.labDocWriteLog.upsert({
    where: { idempotencyKey },
    create: { idempotencyKey, requestHash, route: 'POST /api/lab-docs/upload', status: 'IN_PROGRESS', createdBy: session.userId },
    update: { status: 'IN_PROGRESS', requestHash, createdBy: session.userId },
  })

  // —— 重複偵測：同 sha256 已經有未作廢單據 → 409 { duplicateOf }（§4.2）——
  if (!force) {
    const existing = await prisma.labFile.findMany({
      where: { sha256: { in: rawFiles.map((r) => r.sha256) }, purgedAt: null },
      select: {
        sha256: true,
        uploadedAt: true,
        uploadedBy: true,
        pages: { select: { document: { select: { id: true, status: true } } } },
      },
    })
    for (const f of existing) {
      const activeDoc = f.pages.map((p) => p.document).find((d) => d.status !== 'VOID')
      if (activeDoc) {
        const uploader = await prisma.user.findUnique({
          where: { id: f.uploadedBy },
          select: { name: true },
        })
        // HK wall-clock 日期（同 app 慣例；toISOString 係 UTC，凌晨會錯日期）
        const hkDay = new Date(f.uploadedAt.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
        return NextResponse.json(
          {
            duplicateOf: activeDoc.id,
            duplicateSha256: f.sha256,
            message: `呢個檔已經喺 ${hkDay} 由 ${uploader?.name ?? '不明用戶'} 上傳過`,
          },
          { status: 409 },
        )
      }
    }
  }

  // —— 處理（sharp/pdfjs，昂貴）→ 加密寫碟 → DB 單 transaction ——
  const uploadedAt = new Date()
  const purgeAt = new Date(uploadedAt.getTime() + RETENTION_MS)
  const encKeyId = process.env.LAB_DOC_ENC_KID || 'k1'

  try {
    const prepared: PreparedFile[] = []
    for (const raw of rawFiles) {
      const out = await processUploadFile(raw.buf)
      const fileId = randomUUID().replace(/-/g, '').slice(0, 25) // 25 位 lowercase（storageKey regex）
      const storageKey = buildStorageKey(fileId, uploadedAt)
      const pagesJson = out.pages.map((p) => ({
        page: p.pageNo,
        displayKey: buildPageKey(fileId, uploadedAt, p.pageNo, 'display'),
        thumbKey: buildPageKey(fileId, uploadedAt, p.pageNo, 'thumb'),
        width: p.width,
        height: p.height,
        textChars: p.textChars,
      }))
      prepared.push({ raw, out, fileId, storageKey, pagesJson })
    }

    // 加密寫碟（DB commit 前；中途死 → 孤兒，sweep 24h 後清）
    for (const pf of prepared) {
      await saveEncrypted(pf.storageKey, pf.out.original)
      for (const p of pf.out.pages) {
        await saveEncrypted(buildPageKey(pf.fileId, uploadedAt, p.pageNo, 'display'), p.display)
        await saveEncrypted(buildPageKey(pf.fileId, uploadedAt, p.pageNo, 'thumb'), p.thumb)
      }
    }

    // DB 單 transaction（B15：撳兩下唔會多一筆）
    const documents = await prisma.$transaction(
      async (tx) => {
        const out: Array<{ id: string; status: string }> = []
        // §8.1：月結單「多個檔＝一份」— 多張相／多個 PDF 合成一張單據（頁按上傳次序）
        let stmtDoc: { id: string; status: string } | null = null
        let stmtSort = 0
        for (const pf of prepared) {
          await tx.labFile.create({
            data: {
              id: pf.fileId,
              sha256: pf.raw.sha256,
              mime: pf.out.mime,
              sizeBytes: pf.raw.buf.length,
              pageCount: pf.out.pageCount,
              hasTextLayer: pf.out.hasTextLayer,
              storageKey: pf.storageKey,
              encKeyId,
              pagesJson: pf.pagesJson,
              originalName: pf.raw.name,
              uploadedBy: session.userId,
              uploadedAt,
              purgeAt,
            },
          })
          // ★ cwm-labdoc P2 §7.11（D9）：拆頁 — 每頁一張單據（共用同一 file）
          if (splitPdfPages && pf.pagesJson.length > 1) {
            for (const p of pf.pagesJson) {
              const doc = await tx.labDocument.create({
                data: {
                  kind,
                  status: 'UPLOADED',
                  labId,
                  uploadedBy: session.userId,
                  createdAt: uploadedAt, // 同一批 = 同一個 createdAt（§7.11 合併靠呢個判斷）
                },
              })
              await tx.labDocumentPage.create({
                data: { documentId: doc.id, fileId: pf.fileId, pageNo: p.page, sortOrder: 0 },
              })
              out.push({ id: doc.id, status: doc.status })
            }
          } else if (kind === 'STATEMENT' && prepared.length > 1) {
            if (!stmtDoc) {
              const doc = await tx.labDocument.create({
                data: { kind, status: 'UPLOADED', labId, statementMonth: statementMonth || null, uploadedBy: session.userId, createdAt: uploadedAt },
              })
              stmtDoc = { id: doc.id, status: doc.status }
              out.push(stmtDoc)
            }
            await tx.labDocumentPage.createMany({
              data: pf.pagesJson.map((p) => ({ documentId: stmtDoc!.id, fileId: pf.fileId, pageNo: p.page, sortOrder: stmtSort++ })),
            })
          } else {
            const doc = await tx.labDocument.create({
              data: {
                kind,
                status: 'UPLOADED',
                labId,
                statementMonth: kind === 'STATEMENT' ? statementMonth || null : null,
                uploadedBy: session.userId,
                createdAt: uploadedAt, // 同一批 = 同一個 createdAt（§7.11 合併靠呢個判斷）
              },
            })
            await tx.labDocumentPage.createMany({
              data: pf.pagesJson.map((p, idx) => ({
                documentId: doc.id,
                fileId: pf.fileId,
                pageNo: p.page,
                sortOrder: idx,
              })),
            })
            out.push({ id: doc.id, status: doc.status })
          }
        }
        return out
      },
      { timeout: 60_000 },
    )

    // WriteLog → DONE + 回應快照（冪等 replay 用）
    const response = { documents: documents.map((d) => ({ id: d.id, status: d.status })) }
    await prisma.labDocWriteLog.update({
      where: { idempotencyKey },
      data: { status: 'DONE', responseJson: response as any },
    })

    // audit（§14：LAB_DOC_UPLOAD — EXEMPT；after 只記 fileIds、kind、頁數、sha256 前 12 位）
    await labdocAudit({
      action: 'LAB_DOC_UPLOAD',
      entity: 'LabDocument',
      entityId: documents.length === 1 ? documents[0].id : documents.map((d) => d.id).join(','),
      actorId: session.userId,
      // clinicId 留 null — 上傳時 clinic 未識別（§14：audit clinicId 填文件或成本嘅診所）
      ipAddress: req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || null,
      userAgent: req.headers.get('user-agent') || null,
      notes: `上載 ${kind} ${documents.length} 份（${rawFiles.length} 個檔）${force ? '（force 重傳）' : ''}`,
      after: {
        fileIds: prepared.map((p) => p.fileId),
        kind,
        pageCount: prepared.reduce((a, p) => a + p.out.pageCount, 0),
        sha256Prefix: prepared.map((p) => p.raw.sha256.slice(0, 12)),
      },
    })

    // §5.1：建完單據即回應；同一 request 尾背景讀單（同 apricot/sync/route.ts 做法）。
    // 未設 WA_INBOX_LABDOC_URL → 每張單會行完 3 次後 EXTRACT_FAILED（extractError='not_configured'，
    // 畫面提示「讀單服務未設定，請人手輸入」）；唔會卡上傳回應。
    // INVOICE/STATEMENT 都觸發（§5.1 唔分 kind；月結單對數業務係 §8/P3，但讀單結果 P2 照存 —
    // 見 decision log 2026-10-05 P2-C1 STATEMENT 觸發口徑）。
    for (const d of documents) {
      void runLabDocExtract(d.id).catch((e) => {
        console.error('[labdoc/upload] 背景讀單失敗', { docId: d.id, err: String((e as Error)?.message ?? e) })
      })
    }

    return NextResponse.json(response, { status: 201 })
  } catch (e: any) {
    // WriteLog 保持 IN_PROGRESS（10 分鐘後 stale 可重試）
    if (e instanceof LabDocProcessError) {
      return NextResponse.json({ error: e.message }, { status: e.httpStatus })
    }
    console.error('[labdoc/upload] 失敗', e)
    return NextResponse.json({ error: '上傳失敗：' + (e?.message ?? '未知錯誤') }, { status: 500 })
  }
}
