// ★ cwm-labdoc P2 §7.11：POST /api/lab-docs/merge — 合併 invoice（拆頁嘅逆操作）
//
// 口徑（spec 逐字）：揀 2+ 張同時上傳、未 CONFIRMED 嘅 invoice → 新文件（頁按揀嘅次序）
// → 舊文件 VOID（原因「合併到 {新 id}」）→ 新文件重新讀單。
//
// 守衛：
//   - 2–20 張、cuid 形、唔重複
//   - 全部 INVOICE；status ∈ {UPLOADED, EXTRACTING, EXTRACT_FAILED, NEEDS_REVIEW, DUPLICATE}（未確認、未對過）
//   - 同時上傳（uploadedAt 相同）；同一 Lab（labId 全部相同，可以係 null）
//   - 冇任何 MATCHED 行（有 = 對過數 → 唔使合併）
// 冪等（T4 慣例）：write-log.ts — 同 key 同 hash → replay。
// 權限：lab_invoice（§10.2；角色白名單 OWNER/MANAGER）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { runLabDocExtract } from '@/lib/labdoc/extract'
import { acquireWriteLog, completeWriteLog, stableRequestHash } from '@/lib/labdoc/write-log'

const DOC_ID_RE = /^[a-z0-9]{25}$/
const KEY_RE = /^[a-zA-Z0-9:_-]{1,128}$/
const MERGEABLE = new Set(['UPLOADED', 'EXTRACTING', 'EXTRACT_FAILED', 'NEEDS_REVIEW', 'DUPLICATE'])
const ROUTE_TAG = 'POST /api/lab-docs/merge'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return NextResponse.json({ error: '冇任何診所範圍，唔可以合併單據' }, { status: 403 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '請求 body 格式錯誤' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) return NextResponse.json({ error: '請求 body 格式錯誤' }, { status: 400 })

  const idempotencyKey: string = body.idempotencyKey
  if (!KEY_RE.test(idempotencyKey ?? '')) {
    return NextResponse.json({ error: 'idempotencyKey 缺失或格式錯誤' }, { status: 400 })
  }
  const sourceDocIds: unknown = body.sourceDocIds
  if (!Array.isArray(sourceDocIds) || sourceDocIds.length < 2 || sourceDocIds.length > 20) {
    return NextResponse.json({ error: 'sourceDocIds 要 2–20 張' }, { status: 400 })
  }
  for (const d of sourceDocIds) {
    if (typeof d !== 'string' || !DOC_ID_RE.test(d)) return NextResponse.json({ error: 'sourceDocIds 格式錯誤' }, { status: 400 })
  }
  if (new Set(sourceDocIds as string[]).size !== sourceDocIds.length) {
    return NextResponse.json({ error: 'sourceDocIds 有重複' }, { status: 400 })
  }

  const requestHash = stableRequestHash({ sourceDocIds: sourceDocIds as string[] })
  const acquired = await acquireWriteLog(idempotencyKey, ROUTE_TAG, requestHash, session.userId)
  if (acquired.kind === 'replay') {
    return NextResponse.json({ ...(acquired.response as object), replayed: true }, { status: 200 })
  }
  if (acquired.kind === 'conflict') {
    return NextResponse.json(
      { error: acquired.reason === 'hash_mismatch' ? 'idempotencyKey 已用过但內容唔同 — 請用新 key' : '同一合併請求正在處理中 — 請用新 key' },
      { status: 409 },
    )
  }

  // —— 載入 + 守衛 ——
  const docs = await prisma.labDocument.findMany({ where: { id: { in: sourceDocIds as string[] } } })
  if (docs.length !== sourceDocIds.length) {
    return NextResponse.json({ error: '有單據唔存在' }, { status: 404 })
  }
  for (const doc of docs) {
    if (doc.kind !== 'INVOICE') return NextResponse.json({ error: '只能合併 invoice' }, { status: 400 })
    if (!MERGEABLE.has(doc.status)) {
      return NextResponse.json({ error: `單據 ${doc.docNo ?? doc.id} 狀態 ${doc.status} 未可以合併（要未確認）` }, { status: 400 })
    }
    if (scope !== null && !(doc.clinicId && scope.includes(doc.clinicId))) {
      return NextResponse.json({ error: '有單據唔喺你嘅診所範圍' }, { status: 403 })
    }
  }
  // 同時上傳（同一次上傳批次）
  const uploadedAts = new Set(docs.map((d) => d.createdAt.getTime())) // 同時上傳 = 同一批次（createdAt 同值）
  if (uploadedAts.size !== 1) {
    return NextResponse.json({ error: '只可以合併同一時間上傳嘅單據' }, { status: 400 })
  }
  // 同一 Lab
  const labIds = new Set(docs.map((d) => d.labId ?? ''))
  if (labIds.size !== 1) {
    return NextResponse.json({ error: '唔可以合併唔同 Lab 嘅單據' }, { status: 400 })
  }
  // 冇 MATCHED 行
  const matchedCount = await prisma.labDocumentLine.count({ where: { documentId: { in: docs.map((d) => d.id) }, status: 'MATCHED' } })
  if (matchedCount > 0) {
    return NextResponse.json({ error: '有單據已經對咗數（有配對行）— 唔可以合併' }, { status: 400 })
  }

  // 來源文件（新單據嘅頁要指向同一批 file）
  const sourceIds = sourceDocIds as string[]
  let newDocId: string
  let pageCount: number
  try {
    const created = await prisma.$transaction(
      async (tx: any) => {
        // 新文件（頁按揀嘅次序）
        const newDoc = await tx.labDocument.create({
          data: {
            kind: 'INVOICE',
            status: 'UPLOADED',
            labId: docs[0].labId,
            uploadedBy: session.userId,
          },
        })
        let sortOrder = 0
        let pages = 0
        for (const sourceId of sourceIds) {
          const sourcePages: Array<{ fileId: string; pageNo: number }> = await tx.labDocumentPage.findMany({
            where: { documentId: sourceId },
            orderBy: { sortOrder: 'asc' },
            select: { fileId: true, pageNo: true },
          })
          for (const p of sourcePages) {
            await tx.labDocumentPage.create({
              data: { documentId: newDoc.id, fileId: p.fileId, pageNo: p.pageNo, sortOrder: sortOrder++ },
            })
            pages++
          }
          // 舊文件 VOID（條件寫：狀態要仲係可合併；有人同時確認咗就 0 行 → 回滾）
          const r = await tx.labDocument.updateMany({
            where: { id: sourceId, status: { in: [...MERGEABLE] } },
            data: {
              status: 'VOID',
              voidReason: `合併到 ${newDoc.id}`,
              voidedBy: session.userId,
              voidedAt: new Date(),
            },
          })
          if (r.count === 0) {
            throw new MergeRaceError(sourceId)
          }
        }
        // audit（🔴 唔記任何病人資料 — 只有單據 id／單號）
        await tx.auditLog.create({
          data: {
            actorId: session.userId,
            action: 'LAB_DOC_MERGE',
            entity: 'LabDocument',
            entityId: newDoc.id,
            clinicId: docs[0].clinicId,
            beforeJson: JSON.stringify({ sourceDocIds: sourceIds }),
            afterJson: JSON.stringify({ id: newDoc.id, pageCount: pages }),
            notes: `合併 ${sourceIds.length} 張單據 → ${newDoc.id}`,
          },
        })
        return { newDocId: newDoc.id, pageCount: pages }
      },
      { isolationLevel: 'Serializable', timeout: 60_000 },
    )
    newDocId = created.newDocId
    pageCount = created.pageCount
  } catch (e: any) {
    if (e instanceof MergeRaceError) {
      return NextResponse.json({ error: '有單據嘅狀態啱啱被改咗 — 請重新載入再合併' }, { status: 409 })
    }
    console.error('[labdoc] merge failed', { err: e?.message })
    return NextResponse.json({ error: '合併失敗，請重試' }, { status: 500 })
  }

  // 新文件重新讀單（§5.1 背景工作；未設 LLM → 3 次後 EXTRACT_FAILED）
  void runLabDocExtract(newDocId).catch((e) => {
    console.error('[labdoc/merge] 背景讀單失敗', { docId: newDocId, err: String((e as Error)?.message ?? e) })
  })

  const resp = {
    document: { id: newDocId, status: 'UPLOADED', pageCount },
    voidedDocIds: sourceIds,
  }
  await completeWriteLog(idempotencyKey, resp)
  return jsonNoStore(resp, { status: 201 })
}

class MergeRaceError extends Error {
  constructor(docId: string) {
    super(docId)
    this.name = 'MergeRaceError'
  }
}
