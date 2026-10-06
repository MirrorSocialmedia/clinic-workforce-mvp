// ★ cwm-labdoc P3：POST /api/lab-docs/:id/supersede — §8.1 取代舊版月結單
//
// body：{ oldDocumentId, reason, version }
// - 新文件 = :id（本單）；舊文件 → status=SUPERSEDED、supersededById=新 id（舊分段結果保留做紀錄）
// - reason 必填（≤500 字）
// 權限：lab_statement（§10.2：取代舊版）
// 版本守衛：新文件 doc.version optimistic lock
// audit：LAB_STATEMENT_SUPERSEDE（SPEC：舊 id、新 id、原因）
// ownership-ok: labdoc 全集團範圍（B16）；兩份文件存在＋未 VOID/SUPERSEDED（防 IDOR／重複取代）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'

const DOC_ID_RE = /^[a-z0-9]{25}$/

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }
  if (!DOC_ID_RE.test(params.id)) {
    return jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 })
  }

  let body: { oldDocumentId?: string; reason?: string; version?: number }
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  const { oldDocumentId, reason, version } = body
  if (!oldDocumentId || !DOC_ID_RE.test(oldDocumentId)) {
    return jsonNoStore({ error: 'oldDocumentId 缺失或格式錯誤' }, { status: 400 })
  }
  if (oldDocumentId === params.id) {
    return jsonNoStore({ error: '唔可以用自己取代自己' }, { status: 400 })
  }
  if (!reason || reason.trim() === '' || reason.trim().length > 500) {
    return jsonNoStore({ error: '取代舊版要原因（≤500 字）' }, { status: 400 })
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return jsonNoStore({ error: 'version 必須係非負整數（optimistic lock）' }, { status: 400 })
  }

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  const [newDoc, oldDoc] = await Promise.all([
    prisma.labDocument.findUnique({ where: { id: params.id }, select: { id: true, kind: true, status: true, version: true, clinicId: true, statementMonth: true } }),
    prisma.labDocument.findUnique({ where: { id: oldDocumentId }, select: { id: true, kind: true, status: true, clinicId: true, statementMonth: true, uploadedBy: true } }),
  ])
  if (!newDoc || !oldDoc) {
    return jsonNoStore({ error: '單據唔存在' }, { status: 404 })
  }
  if (newDoc.kind !== 'STATEMENT' || oldDoc.kind !== 'STATEMENT') {
    return jsonNoStore({ error: '只有月結單可以取代舊版' }, { status: 400 })
  }
  if (newDoc.status === 'VOID' || newDoc.status === 'SUPERSEDED') {
    return jsonNoStore({ error: '新文件已作廢或已被取代' }, { status: 409 })
  }
  if (oldDoc.status === 'VOID' || oldDoc.status === 'SUPERSEDED') {
    return jsonNoStore({ error: '舊文件已作廢或已被取代' }, { status: 409 })
  }
  if (newDoc.version !== version) {
    return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null

  // 單 transaction：舊 SUPERSEDED＋新 version++（optimistic lock）
  const ok = await prisma.$transaction(async (tx: any) => {
    const o = await tx.labDocument.updateMany({
      where: { id: oldDoc.id, status: { notIn: ['VOID', 'SUPERSEDED'] } },
      data: { status: 'SUPERSEDED', supersededById: newDoc.id },
    })
    if (o.count === 0) return false
    const n = await tx.labDocument.updateMany({
      where: { id: newDoc.id, version },
      data: { version: { increment: 1 } },
    })
    return n.count > 0
  }, { timeout: 30_000 })

  if (!ok) {
    return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
  }

  await labdocAudit({
    action: 'LAB_STATEMENT_SUPERSEDE',
    entity: 'LabDocument',
    entityId: newDoc.id,
    clinicId: oldDoc.clinicId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: reason.trim(),
    before: { oldDocumentId: oldDoc.id, oldStatus: oldDoc.status },
    after: { newDocumentId: newDoc.id, oldStatus: 'SUPERSEDED', supersededById: newDoc.id, statementMonth: oldDoc.statementMonth },
  })
  return NextResponse.json({ ok: true, oldDocumentId: oldDoc.id, oldStatus: 'SUPERSEDED', supersededById: newDoc.id })
}
