// ★ cwm-labdoc P3：POST /api/lab-docs/:id/sections/:sid/lines/:lid/close-followup — §8.3 INVOICE_WINS「跟進完成」
//
// INVOICE_WINS 行：唔改系統、入待處理「同 Lab 跟進」，跟進完成（收到 Lab 回覆／確認）→
// 寫 followUpClosedAt／followUpClosedBy → 待處理清走（CHUNK 6 查詢跟 followUpClosedAt 過濾）。
// 權限：lab_statement（§10.2）
// audit：LAB_STATEMENT_RESOLVE（notes: followup-closed）
// ownership-ok: labdoc 全集團範圍（B16）；line.section=section.document=doc（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'

const ID_RE = /^[a-z0-9]{25}$/

export async function POST(req: NextRequest, { params }: { params: { id: string; sid: string; lid: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }
  if (![params.id, params.sid, params.lid].every((x) => ID_RE.test(x))) {
    return jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 })
  }

  const doc = await prisma.labDocument.findUnique({
    where: { id: params.id },
    select: { id: true, kind: true, status: true },
  })
  if (!doc || doc.status === 'VOID' || doc.kind !== 'STATEMENT') {
    return jsonNoStore({ error: '單據唔存在或唔係月結單' }, { status: 404 })
  }
  const section = await prisma.labStatementSection.findFirst({
    where: { id: params.sid, documentId: doc.id },
    select: { id: true, clinicId: true },
  })
  if (!section) return jsonNoStore({ error: '分段唔屬於呢張單' }, { status: 404 })
  const line = await prisma.labStatementLine.findFirst({
    where: { id: params.lid, sectionId: section.id },
    select: { id: true, resolution: true, followUpClosedAt: true },
  })
  if (!line) return jsonNoStore({ error: '行唔屬於呢個分段' }, { status: 404 })
  if (line.resolution !== 'INVOICE_WINS') {
    return jsonNoStore({ error: '只有 INVOICE_WINS 行先有跟進可關閉' }, { status: 400 })
  }
  if (line.followUpClosedAt !== null) {
    return jsonNoStore({ error: '跟進已經關閉' }, { status: 409 })
  }

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  const now = new Date()
  const r = await prisma.labStatementLine.updateMany({
    where: { id: line.id, resolution: 'INVOICE_WINS', followUpClosedAt: null },
    data: { followUpClosedAt: now, followUpClosedBy: session.userId },
  })
  if (r.count === 0) {
    return jsonNoStore({ error: '跟進狀態已變動 — 請重讀' }, { status: 409 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  try {
    await labdocAudit({
      action: 'LAB_STATEMENT_RESOLVE',
      entity: 'LabStatementLine',
      entityId: line.id,
      clinicId: section.clinicId,
      actorId: session.userId,
      ipAddress: ip,
      userAgent: ua,
      notes: `followup-closed（doc ${doc.id}）`,
      after: { followUpClosedAt: now.toISOString() },
    })
  } catch (e) {
    console.error('[labdoc] close-followup audit failed', e)
  }

  return NextResponse.json({ ok: true, id: line.id, followUpClosedAt: now.toISOString() })
}
