// ★ cwm-labdoc P2 CHUNK 5：GET /api/lab-docs/pending — §9 待處理 7 類別
// ★ cwm-labdoc P3：加 3 類（STATEMENT_DIFF／MISSING_IN_SYSTEM／NOT_ON_STATEMENT）
// 全部係查詢（唔建表）；每類有數字 badge。
// 權限：route 層 = lab_invoice 或 lab_statement（RBAC matrix + perm override 雙登記）；
//   類別級：按 PENDING_CATEGORY_PERMS 過濾（LOCKED_ADJUST = lab_invoice 或 provider_payout）。
// scope：resolveClinicScope companyWide（B16）— 有 lab 權限 = 全集團；
//   clinicId 查詢參數必須喺 scope 內（scope 收窄時）。
// CSV 匯出（§9）：format=csv 要 lab_statement；文字欄 csvGuardCell（防公式注入）。
// ownership-ok: labdoc 全集團範圍（B16）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import {
  PENDING_CATEGORIES,
  PENDING_CATEGORY_PERMS,
  type NotOnStatementEntry,
  type PendingCategory,
  type PendingItem,
  monthRange,
  nextMonthStr,
  intersectNotOnStatement,
  visibleCategories,
  csvRow,
} from '@/lib/labdoc/pending'

const DOC_ID_RE = /^[a-z0-9]{25}$/
const MAX_LIMIT = 500

function daysBetween(now: Date, ref: Date | null): number | null {
  if (!ref) return null
  return Math.max(0, Math.floor((now.getTime() - ref.getTime()) / 86_400_000))
}

/** YYYY-MM-DD（UTC 安全：doc 日期係 naive — 直接 toString 前 10 位）。 */
function toDayStr(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null
}

async function main(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const categoryParam = (sp.get('category') ?? '').toUpperCase()
  const labId = sp.get('labId') ?? undefined
  const clinicId = sp.get('clinicId') ?? undefined
  const providerId = sp.get('providerId') ?? undefined
  const month = sp.get('month') ?? undefined
  const limitRaw = Number(sp.get('limit') ?? 100)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100))
  const format = sp.get('format')

  if (categoryParam && !PENDING_CATEGORIES.includes(categoryParam as PendingCategory)) {
    return jsonNoStore({ error: `未知類別：${categoryParam}` }, { status: 400 })
  }
  if (labId && !DOC_ID_RE.test(labId)) return jsonNoStore({ error: 'labId 格式錯誤' }, { status: 400 })
  if (clinicId && !DOC_ID_RE.test(clinicId)) return jsonNoStore({ error: 'clinicId 格式錯誤' }, { status: 400 })
  if (providerId && !DOC_ID_RE.test(providerId)) return jsonNoStore({ error: 'providerId 格式錯誤' }, { status: 400 })
  const mRange = month ? monthRange(month) : null
  if (month && !mRange) return jsonNoStore({ error: 'month 格式錯誤（YYYY-MM）' }, { status: 400 })
  if (clinicId && scope !== null && !scope.includes(clinicId)) {
    return jsonNoStore({ error: 'clinicId 唔喺你嘅範圍' }, { status: 403 })
  }

  const now = new Date()
  const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000)
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86_400_000)

  // 共同 doc where（INVOICE 系類別；AMOUNT_REVIEW／NEW_PAYEE 用 kindAny 版）
  const docWhere = (kindAny: boolean): Record<string, unknown> => {
    const w: Record<string, unknown> = {}
    if (!kindAny) w.kind = 'INVOICE'
    if (labId) w.labId = labId
    w.clinicId = clinicId ?? (scope !== null ? { in: scope } : undefined)
    if (providerId) w.providerId = providerId
    if (mRange) w.docDate = { gte: mRange.gte, lt: mRange.lt }
    return w
  }
  // ★ P3：月結單 doc where（month 參數 → statementMonth）
  const stmtWhere = (): Record<string, unknown> => {
    const w: Record<string, unknown> = { kind: 'STATEMENT', status: { notIn: ['VOID', 'SUPERSEDED'] } }
    if (labId) w.labId = labId
    w.clinicId = clinicId ?? (scope !== null ? { in: scope } : undefined)
    if (providerId) w.providerId = providerId
    if (month) w.statementMonth = month
    return w
  }
  // 共同 cost where
  const costWhere = (): Record<string, unknown> => {
    const w: Record<string, unknown> = { category: 'LAB', status: { not: 'VOID' } }
    if (labId) w.labId = labId
    w.clinicId = clinicId ?? (scope !== null ? { in: scope } : undefined)
    if (providerId) w.providerId = providerId
    if (month) w.periodMonth = month
    return w
  }

  const labSel = { lab: { select: { name: true } } } as const

  const results = new Map<PendingCategory, { count: number; items: PendingItem[] }>()

  // ── UNMATCHED_LINE：invoice 行 UNMATCHED、文件 CONFIRMED/PARTIAL、靜置 >3 日 ──
  {
    const where = {
      status: 'UNMATCHED',
      document: {
        ...docWhere(false),
        status: { in: ['CONFIRMED', 'PARTIAL'] },
        updatedAt: { lte: threeDaysAgo },
      },
    }
    const rows = await prisma.labDocumentLine.findMany({
      where,
      select: {
        id: true,
        description: true,
        amount: true,
        patientCode: true,
        document: {
          select: {
            id: true,
            docNo: true,
            docDate: true,
            updatedAt: true,
            clinicId: true,
            providerId: true,
            ...labSel,
          },
        },
      },
      orderBy: { document: { updatedAt: 'asc' } },
      take: limit,
    })
    const count = await prisma.labDocumentLine.count({ where })
    results.set('UNMATCHED_LINE', {
      count,
      items: rows.map((r) => ({
        id: r.id,
        refType: 'LINE' as const,
        docId: r.document.id,
        labName: r.document.lab?.name ?? null,
        clinicId: r.document.clinicId,
        providerId: r.document.providerId,
        docNo: r.document.docNo,
        date: toDayStr(r.document.docDate),
        amount: Number(r.amount),
        patientCode: r.patientCode,
        days: daysBetween(now, r.document.updatedAt),
        extra: r.description,
      })),
    })
  }

  // ── NOT_RECEIVED：labInvoiceLinked=true 而 receivedAt IS NULL、status≠VOID ──
  {
    const where = { ...costWhere(), labInvoiceLinked: true, receivedAt: null }
    const rows = await prisma.costCase.findMany({
      where,
      select: {
        id: true,
        patientCode: true,
        finalCost: true,
        baseCost: true,
        orderedAt: true,
        ...labSel,
        clinicId: true,
        providerId: true,
      },
      orderBy: { orderedAt: 'desc' },
      take: limit,
    })
    const count = await prisma.costCase.count({ where })
    results.set('NOT_RECEIVED', {
      count,
      items: rows.map((r) => ({
        id: r.id,
        refType: 'COST' as const,
        docId: null,
        labName: r.lab?.name ?? null,
        clinicId: r.clinicId,
        providerId: r.providerId,
        docNo: null,
        date: toDayStr(r.orderedAt),
        amount: r.finalCost !== null ? Number(r.finalCost) : r.baseCost !== null ? Number(r.baseCost) : null,
        patientCode: r.patientCode,
        days: daysBetween(now, r.orderedAt),
        extra: null,
      })),
    })
  }

  // ── RECEIVED_NO_INVOICE：category=LAB、receivedAt >14 日、labInvoiceLinked=false ──
  {
    const where = { ...costWhere(), labInvoiceLinked: false, receivedAt: { lte: fourteenDaysAgo } }
    const rows = await prisma.costCase.findMany({
      where,
      select: {
        id: true,
        patientCode: true,
        finalCost: true,
        receivedAt: true,
        ...labSel,
        clinicId: true,
        providerId: true,
      },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    })
    const count = await prisma.costCase.count({ where })
    results.set('RECEIVED_NO_INVOICE', {
      count,
      items: rows.map((r) => ({
        id: r.id,
        refType: 'COST' as const,
        docId: null,
        labName: r.lab?.name ?? null,
        clinicId: r.clinicId,
        providerId: r.providerId,
        docNo: null,
        date: toDayStr(r.receivedAt),
        amount: r.finalCost !== null ? Number(r.finalCost) : null,
        patientCode: r.patientCode,
        days: daysBetween(now, r.receivedAt),
        extra: null,
      })),
    })
  }

  // ── LOCKED_ADJUST：已鎖（lockedByRunId）成本 linkedSum ≠ baseCost ──
  {
    const where = { ...costWhere(), lockedByRunId: { not: null } }
    // linkedSum 要逐筆算（sum MATCHED 行）— 先撈（上限 1000 防 pathological）
    const rows = await prisma.costCase.findMany({
      where,
      select: {
        id: true,
        patientCode: true,
        baseCost: true,
        periodMonth: true,
        ...labSel,
        clinicId: true,
        providerId: true,
        labLines: {
          where: { status: 'MATCHED', document: { status: { notIn: ['VOID', 'DUPLICATE'] } } },
          select: { amount: true },
        },
      },
      take: 1000,
    })
    const adjusted = rows
      .map((r) => {
        const linkedSum = Math.round(r.labLines.reduce((a, l) => a + Number(l.amount), 0) * 100) / 100
        return { r, linkedSum }
      })
      .filter(({ r, linkedSum }) => r.baseCost !== null && Math.abs(linkedSum - Number(r.baseCost)) > 0.005)
    results.set('LOCKED_ADJUST', {
      count: adjusted.length,
      items: adjusted.slice(0, limit).map(({ r, linkedSum }) => ({
        id: r.id,
        refType: 'COST' as const,
        docId: null,
        labName: r.lab?.name ?? null,
        clinicId: r.clinicId,
        providerId: r.providerId,
        docNo: null,
        date: null,
        amount: linkedSum,
        patientCode: r.patientCode,
        days: null,
        extra: `baseCost=${Number(r.baseCost as any)} linkedSum=${linkedSum} diff=${Math.round((linkedSum - Number(r.baseCost as any)) * 100) / 100}`,
      })),
    })
  }

  // ── AMOUNT_REVIEW：manualAmountEdit=true 而 amountReviewedAt IS NULL ──
  {
    const where = {
      ...docWhere(true),
      manualAmountEdit: true,
      amountReviewedAt: null,
      status: { not: 'VOID' },
    }
    const rows = await prisma.labDocument.findMany({
      where,
      select: { id: true, docNo: true, docDate: true, total: true, kind: true, version: true, ...labSel, clinicId: true, providerId: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    })
    const count = await prisma.labDocument.count({ where })
    results.set('AMOUNT_REVIEW', {
      count,
      items: rows.map((r) => ({
        id: r.id,
        refType: 'DOC' as const,
        docId: r.id,
        labName: r.lab?.name ?? null,
        clinicId: r.clinicId,
        providerId: r.providerId,
        docNo: r.docNo,
        date: toDayStr(r.docDate),
        amount: r.total !== null ? Number(r.total) : null,
        patientCode: null,
        days: null,
        extra: r.kind,
        version: r.version,
      })),
    })
  }

  // ── NEW_PAYEE：payeeIsNew=true（認到 Lab 而 payee 唔喺 PAYEE alias）──
  {
    const where = { ...docWhere(true), payeeIsNew: true, status: { not: 'VOID' } }
    const rows = await prisma.labDocument.findMany({
      where,
      select: { id: true, docNo: true, docDate: true, payeeRaw: true, version: true, ...labSel, clinicId: true, providerId: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    const count = await prisma.labDocument.count({ where })
    results.set('NEW_PAYEE', {
      count,
      items: rows.map((r) => ({
        id: r.id,
        refType: 'DOC' as const,
        docId: r.id,
        labName: r.lab?.name ?? null,
        clinicId: r.clinicId,
        providerId: r.providerId,
        docNo: r.docNo,
        date: toDayStr(r.docDate),
        amount: null,
        patientCode: null,
        days: null,
        extra: r.payeeRaw,
        version: r.version,
      })),
    })
  }

  // ── EXTRACT_FAILED：讀單失敗（可 retry）──
  {
    const where = { ...docWhere(true), status: 'EXTRACT_FAILED' }
    const rows = await prisma.labDocument.findMany({
      where,
      select: { id: true, docNo: true, extractError: true, extractAttempts: true, ...labSel, clinicId: true, providerId: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    })
    const count = await prisma.labDocument.count({ where })
    results.set('EXTRACT_FAILED', {
      count,
      items: rows.map((r) => ({
        id: r.id,
        refType: 'DOC' as const,
        docId: r.id,
        labName: r.lab?.name ?? null,
        clinicId: r.clinicId,
        providerId: r.providerId,
        docNo: r.docNo,
        date: null,
        amount: null,
        patientCode: null,
        days: null,
        extra: r.extractError ? `${r.extractError}（attempts=${r.extractAttempts}）` : `attempts=${r.extractAttempts}`,
      })),
    })
  }

  // ── ★ P3 STATEMENT_DIFF：月結單行 *_DIFF／NEEDS_MANUAL 未處理；或 INVOICE_WINS 未跟進完成 ──
  {
    const where = {
      OR: [
        { result: { in: ['QTY_DIFF', 'PRICE_DIFF', 'AMOUNT_DIFF', 'NEEDS_MANUAL'] }, resolution: null },
        { resolution: 'INVOICE_WINS', followUpClosedAt: null },
      ],
      section: { document: stmtWhere() },
    }
    const rows = await prisma.labStatementLine.findMany({
      where,
      select: {
        id: true,
        docNo: true,
        date: true,
        amount: true,
        description: true,
        result: true,
        resolution: true,
        patientCode: true,
        section: {
          select: { id: true, document: { select: { id: true, statementMonth: true, updatedAt: true, clinicId: true, providerId: true, ...labSel } } },
        },
      },
      orderBy: { section: { document: { updatedAt: 'asc' } } },
      take: limit,
    })
    const count = await prisma.labStatementLine.count({ where })
    results.set('STATEMENT_DIFF', {
      count,
      items: rows.map((r) => ({
        id: r.id,
        refType: 'LINE' as const,
        docId: r.section.document.id,
        sectionId: r.section.id,
        labName: r.section.document.lab?.name ?? null,
        clinicId: r.section.document.clinicId,
        providerId: r.section.document.providerId,
        docNo: r.docNo,
        date: toDayStr(r.date),
        amount: Number(r.amount),
        patientCode: r.patientCode,
        days: daysBetween(now, r.section.document.updatedAt),
        extra: r.resolution === 'INVOICE_WINS' ? 'INVOICE_WINS 跟進中' : `${r.result}${r.description ? `｜${r.description}` : ''}`,
      })),
    })
  }

  // ── ★ P3 MISSING_IN_SYSTEM：月結單行 MISSING_IN_SYSTEM 未有 resolution（補上傳）──
  {
    const where = {
      result: 'MISSING_IN_SYSTEM',
      resolution: null,
      section: { document: stmtWhere() },
    }
    const rows = await prisma.labStatementLine.findMany({
      where,
      select: {
        id: true,
        docNo: true,
        date: true,
        amount: true,
        description: true,
        patientCode: true,
        section: { select: { id: true, document: { select: { id: true, updatedAt: true, clinicId: true, providerId: true, ...labSel } } } },
      },
      orderBy: { section: { document: { updatedAt: 'asc' } } },
      take: limit,
    })
    const count = await prisma.labStatementLine.count({ where })
    results.set('MISSING_IN_SYSTEM', {
      count,
      items: rows.map((r) => ({
        id: r.id,
        refType: 'LINE' as const,
        docId: r.section.document.id,
        sectionId: r.section.id,
        labName: r.section.document.lab?.name ?? null,
        clinicId: r.section.document.clinicId,
        providerId: r.section.document.providerId,
        docNo: r.docNo,
        date: toDayStr(r.date),
        amount: Number(r.amount),
        patientCode: r.patientCode,
        days: daysBetween(now, r.section.document.updatedAt),
        extra: r.description ?? null,
      })),
    })
  }

  // ── ★ P3 NOT_ON_STATEMENT：§8.2 反向，M 同 M+1 都確認咗仍然冇 ──
  {
    const monthWhere: Record<string, unknown> = {}
    if (month) {
      const nx = nextMonthStr(month)
      monthWhere.statementMonth = nx ? { in: [month, nx] } : month
    } else {
      // badge 口徑：近 24 個月
      const idx = now.getUTCFullYear() * 12 + now.getUTCMonth() - 24 // month = 0-based → 減 24 個月
      const by = Math.floor(idx / 12)
      const bmo = (idx % 12) + 1
      monthWhere.statementMonth = { gte: `${by}-${String(bmo).padStart(2, '0')}` }
    }
    const stmtDocs = await prisma.labDocument.findMany({
      where: { kind: 'STATEMENT', status: 'RECONCILED', ...monthWhere },
      select: {
        statementMonth: true,
        sections: {
          where: { status: 'CONFIRMED' },
          select: {
            resultJson: true,
            clinicId: true,
            providerId: true,
            document: { select: { labId: true, lab: { select: { name: true } } } },
          },
        },
      },
      orderBy: { statementMonth: 'asc' },
    })
    const byMonth = new Map<string, NotOnStatementEntry[]>()
    for (const d of stmtDocs) {
      if (!d.statementMonth) continue
      const arr = byMonth.get(d.statementMonth) ?? []
      for (const s of d.sections) {
        const nj = (s.resultJson ?? null) as any
        const nos = Array.isArray(nj?.notOnStatement) ? nj.notOnStatement : []
        for (const e of nos) {
          if (e && typeof e.docId === 'string') {
            arr.push({
              docId: e.docId,
              docNo: typeof e.docNo === 'string' ? e.docNo : null,
              docDate: typeof e.docDate === 'string' ? e.docDate : null,
              total: e.total == null ? null : Number(e.total),
              clinicId: s.clinicId,
              providerId: s.providerId,
              labId: s.document.labId,
              labName: s.document.lab?.name ?? null,
            })
          }
        }
      }
      byMonth.set(d.statementMonth, arr)
    }
    const items = intersectNotOnStatement(byMonth, { month, labId, clinicId, providerId, scope })
    results.set('NOT_ON_STATEMENT', { count: items.length, items: items.slice(0, limit) })
  }

  // ── 按權限過濾 + 收縮 ────────────────────────────────────
  const allowed = new Set(visibleCategories(perms ?? []))
  const only = categoryParam ? [categoryParam as PendingCategory] : PENDING_CATEGORIES
  const categories = only
    .filter((c) => allowed.has(c))
    .map((c) => ({ key: c, count: results.get(c)?.count ?? 0, items: results.get(c)?.items ?? [] }))
  const total = categories.reduce((a, c) => a + c.count, 0)

  // ── CSV（§9：lab_statement；文字欄 csvGuardCell）──────────
  if (format === 'csv') {
    if (!(perms ?? []).includes('lab_statement')) {
      return jsonNoStore({ error: 'CSV 匯出需要 lab_statement 權限' }, { status: 403 })
    }
    const lines = [csvRow(['category', 'id', 'refType', 'lab', 'clinicId', 'providerId', 'docNo', 'date', 'amount', 'patientCode', 'days', 'extra'])]
    for (const c of categories) {
      for (const it of c.items) {
        lines.push(csvRow([c.key, it.id, it.refType, it.labName, it.clinicId, it.providerId, it.docNo, it.date, it.amount, it.patientCode, it.days, it.extra]))
      }
    }
    const csv = '\uFEFF' + lines.join('\r\n') // BOM — Excel 中文
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="labdoc-pending-${now.toISOString().slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
      },
    })
  }

  return jsonNoStore({ categories, total })
}

export async function GET(req: NextRequest) {
  try {
    return await main(req)
  } catch (e) {
    console.error('pending GET error', e)
    return jsonNoStore({ error: '伺服器錯誤' }, { status: 500 })
  }
}
