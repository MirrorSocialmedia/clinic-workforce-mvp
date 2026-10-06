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
import { findStatementSectionDuplicate } from '@/lib/labdoc/statement-sections'

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
      lines: {
        orderBy: [{ groupIndex: 'asc' }, { lineIndex: 'asc' }],
        include: { costCase: { select: { id: true, itemType: true, itemTypeOther: true, baseCost: true, status: true, providerId: true } } },
      },
      // ★ P3 §8.1：月結單分段＋行（含逐段重複擋實時計算）
      sections: {
        orderBy: { sectionIndex: 'asc' },
        include: { lines: { orderBy: { lineIndex: 'asc' } } },
      },
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
    // ★ P2 §7.1：行（確認 UI 用）— groups = 行嘅分組集合（含空分組由 groupCount 帶）
    lines: doc.lines.map((l) => ({
      id: l.id,
      groupIndex: l.groupIndex,
      lineIndex: l.lineIndex,
      description: l.description,
      toothRaw: l.toothRaw,
      qty: l.qty == null ? null : Number(l.qty),
      unitPrice: l.unitPrice == null ? null : Number(l.unitPrice),
      listPrice: l.listPrice == null ? null : Number(l.listPrice),
      discountRaw: l.discountRaw,
      amount: Number(l.amount),
      isZero: l.isZero,
      status: l.status,
      ignoreReason: l.ignoreReason,
      patientCodeRaw: l.patientCodeRaw,
      patientCode: l.patientCode,
      patientNameRaw: l.patientNameRaw,
      labCaseRef: l.labCaseRef,
      costCaseId: l.costCaseId,
      linkType: l.linkType,
      costCase: l.costCase
        ? { id: l.costCase.id, itemType: l.costCase.itemType, itemTypeOther: l.costCase.itemTypeOther, baseCost: l.costCase.baseCost == null ? null : Number(l.costCase.baseCost), status: l.costCase.status, providerId: l.costCase.providerId }
        : null,
    })),
    groupCount: doc.lines.reduce((m, l) => Math.max(m, l.groupIndex + 1), 0),
    // ★ P3 §8.1：月結單分段（含逐段重複擋：同 Lab＋診所＋醫生＋月有另一份活動月結單 → duplicate 提示＋「取代舊版」）
    sections: doc.kind === 'STATEMENT'
      ? await Promise.all(
          doc.sections.map(async (s) => {
            const dup =
              s.clinicId && s.providerId && doc.status !== 'VOID' && doc.status !== 'SUPERSEDED'
                ? await findStatementSectionDuplicate(prisma, {
                    labId: doc.labId,
                    clinicId: s.clinicId,
                    providerId: s.providerId,
                    statementMonth: doc.statementMonth,
                    selfDocId: doc.id,
                  })
                : null
            // ★ P3 §8.5 折扣證據監察：Σ 相關成本 finalCost vs statedTotal；唔等而因 discountPct 有值 → 紅提示＋連結
            const matchedLineIds = s.lines.map((l) => l.matchedLineId).filter((x): x is string => !!x)
            let costEvidence: {
              totalFinalCost: number | null
              discountCosts: Array<{ id: string; itemType: string | null; discountPct: number }>
              flag: boolean
            } = { totalFinalCost: null, discountCosts: [], flag: false }
            if (matchedLineIds.length > 0) {
              const dl = await prisma.labDocumentLine.findMany({ where: { id: { in: matchedLineIds } }, select: { costCaseId: true } })
              const ccIds = [...new Set(dl.map((x) => x.costCaseId).filter((x): x is string => !!x))]
              if (ccIds.length > 0) {
                const ccs = await prisma.costCase.findMany({
                  where: { id: { in: ccIds }, status: { not: 'VOID' } },
                  select: { id: true, itemType: true, finalCost: true, discountPct: true },
                })
                const totalFinalCost = Math.round(ccs.reduce((sum, c) => sum + (c.finalCost == null ? 0 : Number(c.finalCost)), 0) * 100) / 100
                const discountCosts = ccs
                  .filter((c) => c.discountPct != null)
                  .map((c) => ({ id: c.id, itemType: c.itemType, discountPct: Number(c.discountPct) }))
                const stated = s.statedTotal != null ? Number(s.statedTotal) : s.statedCurrent != null ? Number(s.statedCurrent) : null
                const flag = stated != null && Math.abs(totalFinalCost - stated) > 0.01 && discountCosts.length > 0
                costEvidence = { totalFinalCost, discountCosts, flag }
              }
            }
            return {
              id: s.id,
              sectionIndex: s.sectionIndex,
              pageFrom: s.pageFrom,
              pageTo: s.pageTo,
              clinicRaw: s.clinicRaw,
              doctorRaw: s.doctorRaw,
              customerNoRaw: s.customerNoRaw,
              clinicId: s.clinicId,
              providerId: s.providerId,
              clinicBasis: s.clinicBasis,
              providerBasis: s.providerBasis,
              statedTotal: s.statedTotal == null ? null : Number(s.statedTotal),
              statedCurrent: s.statedCurrent == null ? null : Number(s.statedCurrent),
              systemTotal: s.systemTotal == null ? null : Number(s.systemTotal),
              status: s.status,
              confirmedBy: s.confirmedBy,
              confirmedAt: s.confirmedAt,
              note: s.note,
              resultJson: s.resultJson,
              // §8.5：折扣證據（紅提示）
              costEvidence,
              // §8.1：重複擋（UI 顯示「{月} {診所} {醫生} 嘅月結單已經喺 {date} 上傳」＋「取代舊版」）
              duplicate: dup
                ? {
                    docId: dup.docId,
                    uploadedAt: new Date(dup.uploadedAt.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10),
                    uploadedBy: dup.uploadedBy,
                  }
                : null,
              lines: s.lines.map((l) => ({
                id: l.id,
                lineIndex: l.lineIndex,
                lineType: l.lineType,
                docNoRaw: l.docNoRaw,
                docNo: l.docNo,
                date: l.date,
                patientRaw: l.patientRaw,
                patientCode: l.patientCode,
                labCaseRef: l.labCaseRef,
                description: l.description,
                toothRaw: l.toothRaw,
                qty: l.qty == null ? null : Number(l.qty),
                unitPrice: l.unitPrice == null ? null : Number(l.unitPrice),
                amount: Number(l.amount),
                agingBucket: l.agingBucket,
                matchedDocumentId: l.matchedDocumentId,
                matchedLineId: l.matchedLineId,
                matchBasis: l.matchBasis,
                result: l.result,
                resolution: l.resolution,
                resolutionNote: l.resolutionNote,
                resolvedBy: l.resolvedBy,
                resolvedAt: l.resolvedAt,
                followUpClosedAt: l.followUpClosedAt,
                followUpClosedBy: l.followUpClosedBy,
              })),
            }
          }),
        )
      : [],
    // §8.1：statementMonth 係行最遲日期推斷（AI／預選都冇）→ UI 標黃
    statementMonthFromLines: doc.readIssues.includes('STATEMENT_MONTH_FROM_LINES'),
  })
}

// ★ cwm-labdoc P2 §7.10：DELETE /api/lab-docs/:id — 作廢 invoice
// 冇 MATCHED 行先得（有要先解除配對）；要原因（≤200 字）；status = VOID；
// 原檔保留（purge 係月度 job 嘅事）；docNo 可以再用（重複檢查排除 VOID）；audit LAB_DOC_VOID。
// 權限：lab_invoice（§10.2；角色白名單 OWNER/MANAGER）
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params
  if (!DOC_ID_RE.test(id)) {
    return NextResponse.json({ error: '單據 ID 格式錯誤' }, { status: 400 })
  }

  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return NextResponse.json({ error: '冇任何診所範圍，唔可以作廢單據' }, { status: 403 })
  }

  // §11：作廢 invoice = lab_invoice；月結單 = lab_statement（先查 kind 再定權限）
  const doc0 = await prisma.labDocument.findUnique({ where: { id }, select: { id: true, kind: true } })
  if (!doc0) return NextResponse.json({ error: '單據唔存在' }, { status: 404 })
  const needPerm = doc0.kind === 'STATEMENT' ? 'lab_statement' : 'lab_invoice'
  if (!(perms ?? []).includes(needPerm)) {
    return jsonNoStore({ error: `需要 ${needPerm} 權限` }, { status: 403 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const reason: unknown = typeof body === 'object' && body !== null ? body.reason : undefined
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.trim().length > 200) {
    return NextResponse.json({ error: 'reason 必填（1–200 字）' }, { status: 400 })
  }

  const doc = await prisma.labDocument.findUnique({ where: { id } })
  if (!doc || doc.id !== id) return NextResponse.json({ error: '單據唔存在' }, { status: 404 })
  if (scope !== null && !(doc.clinicId && scope.includes(doc.clinicId))) {
    return NextResponse.json({ error: '單據唔存在' }, { status: 404 })
  }
  if (doc.kind !== 'INVOICE' && doc.kind !== 'STATEMENT') {
    return NextResponse.json({ error: '單據類型唔支援作廢' }, { status: 400 })
  }
  if (doc.status === 'VOID') {
    return NextResponse.json({ error: '單據已經作廢咗' }, { status: 400 })
  }

  const matched = await prisma.labDocumentLine.count({ where: { documentId: id, status: 'MATCHED' } })
  if (matched > 0) {
    return NextResponse.json({ error: `呢張單仲有 ${matched} 條已配對行 — 要先解除配對（或作廢成本）先可以作廢` }, { status: 409 })
  }

  const updated = await prisma.$transaction(async (tx: any) => {
    const r = await tx.labDocument.update({
      where: { id },
      data: {
        status: 'VOID',
        voidReason: reason.trim(),
        voidedBy: session.userId,
        voidedAt: new Date(),
        version: { increment: 1 },
      },
    })
    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'LAB_DOC_VOID',
        entity: 'LabDocument',
        entityId: id,
        clinicId: doc.clinicId,
        beforeJson: JSON.stringify({ status: doc.status, docNo: doc.docNo }),
        afterJson: JSON.stringify({ status: 'VOID', voidReason: reason.trim() }),
        notes: `作廢單據 ${doc.docNo ?? '(no docNo)'}`,
      },
    })
    return r
  })

  return jsonNoStore({ document: { id: updated.id, status: updated.status, version: updated.version } })
}
