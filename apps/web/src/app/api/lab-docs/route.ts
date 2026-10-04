// ★ cwm-labdoc P1：GET /api/lab-docs — 列表／檔案庫（§4.3、§11）
// filters：kind、status（csv）、labId、clinicId、providerId、month、q、ids（csv）、page
// → { items: [{document, labName, firstPageThumb, pageCount, uploadedByName}], total, page, pageSize }
// 已作廢／DUPLICATE／SUPERSEDED 正常列出（UI 灰色顯示；存底唔刪 — B7）
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'

const PAGE_SIZE = 20

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  // §10.3：所有 labdoc route 用 resolveClinicScope — 有 lab 權限 = 全集團（B16）
  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE }) // fail-closed：冇範圍 = 乜都睇唔到
  }

  const sp = req.nextUrl.searchParams
  const kind = sp.get('kind')
  const status = sp.get('status')?.split(',').map((s) => s.trim()).filter(Boolean)
  const labId = sp.get('labId')
  const clinicId = sp.get('clinicId')
  const providerId = sp.get('providerId')
  const month = sp.get('month') // YYYY-MM（STATEMENT=statementMonth；INVOICE=docDate 月份）
  const q = sp.get('q')?.trim()
  const ids = sp.get('ids')?.split(',').map((s) => s.trim()).filter(Boolean)
  const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1)

  const where: Record<string, any> = {}
  if (scope) where.clinicId = { in: scope }
  if (kind === 'INVOICE' || kind === 'STATEMENT') where.kind = kind
  if (status?.length) where.status = { in: status }
  if (labId) where.labId = labId
  if (clinicId) where.clinicId = clinicId
  if (providerId) where.providerId = providerId
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    const start = new Date(Date.UTC(y, m - 1, 1))
    const end = new Date(Date.UTC(y, m, 1))
    if (kind === 'STATEMENT') {
      where.statementMonth = month
    } else {
      // INVOICE：§4.3 — month = docDate 該月
      where.docDate = { gte: start, lt: end }
    }
  }
  if (ids?.length) {
    where.id = { in: ids }
  }
  if (q) {
    where.OR = [
      ...(where.OR ?? []),
      { docNo: { contains: q, mode: 'insensitive' as const } },
      { labNameRaw: { contains: q, mode: 'insensitive' as const } },
      { customerNoRaw: { contains: q, mode: 'insensitive' as const } },
    ]
  }

  const [total, docs] = await Promise.all([
    prisma.labDocument.count({ where }),
    prisma.labDocument.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
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
    }),
  ])

  const items = docs.map((d) => {
    const firstPage = d.pages[0]
    const firstFile = firstPage?.file
    let thumbKey: string | null = null
    let firstPageNo: number | null = null
    if (firstFile && firstFile.pagesJson) {
      const pj = firstFile.pagesJson as Array<{ page: number; thumbKey: string }>
      const firstPj = pj.find((p) => p.page === firstPage?.pageNo) ?? pj[0]
      if (firstPj) {
        thumbKey = firstPj.thumbKey
        firstPageNo = firstPj.page
      }
    }
    return {
      id: d.id,
      kind: d.kind,
      status: d.status,
      labId: d.labId,
      labName: d.lab?.name ?? null,
      labNameRaw: d.labNameRaw,
      clinicId: d.clinicId,
      providerId: d.providerId,
      docNo: d.docNo,
      docNoKind: d.docNoKind,
      docDate: d.docDate,
      deliveryDate: d.deliveryDate,
      statementMonth: d.statementMonth,
      statementKind: d.statementKind,
      subtotal: d.subtotal?.toString() ?? null,
      total: d.total?.toString() ?? null,
      version: d.version,
      duplicateOfId: d.duplicateOfId,
      supersededById: d.supersededById,
      voidedAt: d.voidedAt,
      uploadedBy: d.uploadedBy,
      uploadedAt: d.createdAt, // LabDocument 冇 uploadedAt（§3）— 用 createdAt
      pageCount: d.pages.reduce((a, p) => a + p.file.pageCount, 0) || d.pages.length,
      firstFileId: firstFile?.id ?? null,
      firstPageNo,
      thumbKey,
    }
  })

  return jsonNoStore({ items, total, page, pageSize: PAGE_SIZE })
}
