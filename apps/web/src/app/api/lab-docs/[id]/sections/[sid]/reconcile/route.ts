// ★ cwm-labdoc P3：POST /api/lab-docs/:id/sections/:sid/reconcile — §8.2 跑／重跑配對
//
// 分組配對（三型 A/B/C，純函數 statement-match.ts）寫回 LabStatementLine.result／matched*；
// 已有 resolution 嘅行保留（重跑唔洗重複處理）；section 重算 systemTotal／status OK|DIFF／resultJson。
// 權限：lab_statement（§10.2：處理差異）
// audit：LAB_STATEMENT_RECONCILE（SPEC：分段結果統計、差額）
// ownership-ok: labdoc 全集團範圍（B16）；section 必屬呢個 doc（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { reconcileSection } from '@/lib/labdoc/statement-reconcile'

const SECTION_ID_RE = /^[a-z0-9]{25}$/
const DOC_ID_RE = /^[a-z0-9]{25}$/

export async function POST(req: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }
  if (!DOC_ID_RE.test(params.id) || !SECTION_ID_RE.test(params.sid)) {
    return jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 })
  }

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  const doc = await prisma.labDocument.findUnique({
    where: { id: params.id },
    select: { id: true, kind: true, status: true },
  })
  if (!doc || doc.status === 'VOID') {
    return jsonNoStore({ error: '單據唔存在或已作廢' }, { status: 404 })
  }
  if (doc.kind !== 'STATEMENT') {
    return jsonNoStore({ error: '呢張單唔係月結單' }, { status: 400 })
  }

  const section = await prisma.labStatementSection.findFirst({
    where: { id: params.sid, documentId: doc.id },
    select: { id: true },
  })
  if (!section) {
    return jsonNoStore({ error: '分段唔屬於呢張單' }, { status: 404 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  const r = await reconcileSection(prisma, {
    sectionId: section.id,
    actorId: session.userId,
    source: 'manual',
    ipAddress: ip,
    userAgent: ua,
  })
  if (!r.ok) {
    const status = r.code === 'NOT_FOUND' ? 404 : 400
    return jsonNoStore({ error: r.message, code: r.code }, { status })
  }
  return NextResponse.json(r)
}
