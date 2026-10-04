// ★ cwm-labdoc P1：GET /api/lab-docs/:id — 單據詳情（§11、§4.3 檢視器用）
// P1 範圍：頭部 + 頁（fileId,pageNo）+ readIssues。
// groups＋行／分段＋行 = P2/P3（讀單＋對數）先開 — 呢度唔預設空結構，避免 UI 假設。
// 權限：lab_invoice 或 lab_statement（§10.2）；全集團範圍（B16）
// ownership-ok: labdoc 全集團範圍（B16）；resolveClinicScope companyWide ＋ clinicId 範圍檢查（寫入 route 另驗 costCase 同 doc 同 Lab 同病人）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'

const DOC_ID_RE = /^[a-z0-9]{25}$/

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  // §10.3：所有 labdoc route 用 resolveClinicScope — 有 lab 權限 = 全集團（B16）
  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍，唔可以睇單據' }, { status: 403 })
  }

  const { id } = params
  if (!DOC_ID_RE.test(id)) {
    return NextResponse.json({ error: '單據 ID 格式錯誤' }, { status: 400 })
  }

  const doc = await prisma.labDocument.findUnique({
    where: { id },
    include: {
      lab: { select: { id: true, name: true, isActive: true } },
      pages: {
        orderBy: { sortOrder: 'asc' },
        include: {
          file: {
            select: {
              id: true,
              mime: true,
              pageCount: true,
              hasTextLayer: true,
              pagesJson: true,
              uploadedAt: true,
              purgedAt: true,
            },
          },
        },
      },
    },
  })
  if (!doc) return NextResponse.json({ error: '單據唔存在' }, { status: 404 })

  // 有限範圍用戶：單據 clinic 要喺範圍內（clinic 未識別 + 有限範圍 = fail-closed）
  if (scope !== null && !(doc.clinicId && scope.includes(doc.clinicId))) {
    return NextResponse.json({ error: '單據唔存在' }, { status: 404 })
  }

  return jsonNoStore({
    document: {
      id: doc.id,
      kind: doc.kind,
      status: doc.status,
      labId: doc.labId,
      labName: doc.lab?.name ?? null,
      labNameRaw: doc.labNameRaw,
      labBasis: doc.labBasis,
      clinicId: doc.clinicId,
      clinicBasis: doc.clinicBasis,
      clinicEvidence: doc.clinicEvidence,
      providerId: doc.providerId,
      providerBasis: doc.providerBasis,
      providerEvidence: doc.providerEvidence,
      customerNoRaw: doc.customerNoRaw,
      docNo: doc.docNo,
      docNoKind: doc.docNoKind,
      docDate: doc.docDate,
      deliveryDate: doc.deliveryDate,
      orderReceivedDate: doc.orderReceivedDate,
      statementMonth: doc.statementMonth,
      statementKind: doc.statementKind,
      subtotal: doc.subtotal?.toString() ?? null,
      total: doc.total?.toString() ?? null,
      payeeRaw: doc.payeeRaw,
      payeeIsNew: doc.payeeIsNew,
      extractSource: doc.extractSource,
      readIssues: doc.readIssues,
      manualAmountEdit: doc.manualAmountEdit,
      amountReviewedBy: doc.amountReviewedBy,
      amountReviewedAt: doc.amountReviewedAt,
      version: doc.version,
      duplicateOfId: doc.duplicateOfId,
      supersededById: doc.supersededById,
      voidReason: doc.voidReason,
      voidedBy: doc.voidedBy,
      voidedAt: doc.voidedAt,
      uploadedBy: doc.uploadedBy,
      confirmedBy: doc.confirmedBy,
      confirmedAt: doc.confirmedAt,
      createdAt: doc.createdAt,
    },
    pages: doc.pages.map((p) => ({
      id: p.id,
      pageNo: p.pageNo,
      sortOrder: p.sortOrder,
      file: {
        id: p.file.id,
        mime: p.file.mime,
        pageCount: p.file.pageCount,
        hasTextLayer: p.file.hasTextLayer,
        pagesJson: p.file.pagesJson,
        uploadedAt: p.file.uploadedAt,
        purgedAt: p.file.purgedAt,
      },
    })),
  })
}
