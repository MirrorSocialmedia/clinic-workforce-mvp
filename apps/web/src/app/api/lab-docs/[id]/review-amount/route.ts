// ★ cwm-labdoc P2 CHUNK 5：POST /api/lab-docs/:id/review-amount — §11 人手改數覆核
//
// AMOUNT_REVIEW（§9）：manualAmountEdit=true 而未覆核 → lab_statement 對相覆核 →
// 寫 amountReviewedAt/amountReviewedBy，離開待處理列表。
// 權限：lab_statement（§10.2 覆核人手改數）
// 版本守衛：optimistic lock（version）— 0 row = 409（重讀重試）
// audit：LAB_DOC_AMOUNT_REVIEW（sensitive-audit SPEC 已有）
// ownership-ok: labdoc 全集團範圍（B16）；寫入前驗證文件存在＋未 VOID＋scope
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }

  let body: { version?: number }
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  const { version } = body
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return jsonNoStore({ error: 'version 必須係非負整數（optimistic lock）' }, { status: 400 })
  }

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  const doc = await prisma.labDocument.findUnique({
    where: { id: params.id },
    select: { id: true, clinicId: true, manualAmountEdit: true, amountReviewedAt: true, status: true, version: true },
  })
  if (!doc || doc.status === 'VOID') {
    return jsonNoStore({ error: '單據唔存在或已作廢' }, { status: 404 })
  }
  if (scope !== null && (!doc.clinicId || !scope.includes(doc.clinicId))) {
    return jsonNoStore({ error: '單據唔喺你嘅範圍' }, { status: 403 })
  }
  if (doc.version !== version) {
    return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
  }
  if (!doc.manualAmountEdit || doc.amountReviewedAt !== null) {
    return jsonNoStore({ error: '單據唔係人手改數待覆核狀態' }, { status: 400 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  const now = new Date()

  const upd = await prisma.labDocument.updateMany({
    where: { id: params.id, version, amountReviewedAt: null },
    data: { amountReviewedAt: now, amountReviewedBy: session.userId, version: { increment: 1 } },
  })
  if (upd.count === 0) return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })

  await labdocAudit({
    action: 'LAB_DOC_AMOUNT_REVIEW',
    entity: 'LabDocument',
    entityId: params.id,
    clinicId: doc.clinicId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    before: { manualAmountEdit: true, amountReviewedAt: null },
    after: { amountReviewedAt: now.toISOString(), amountReviewedBy: session.userId },
  })
  return NextResponse.json({ ok: true, id: params.id })
}
