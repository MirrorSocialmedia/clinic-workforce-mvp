// ★ cwm-labdoc P3：POST /api/lab-docs/:id/sections/:sid/confirm — §8.4 確認分段
//
// 條件（全部通過先 CONFIRMED）：
//  ① 每行 result ∈ {MATCHED, PREVIOUSLY_MATCHED, NOT_APPLICABLE} 或者有 resolution
//     （*_DIFF／MISSING_IN_SYSTEM／NEEDS_MANUAL／PENDING 未處理 → 擋）
//  ② §5.5 分段讀數檢查：Σ 行 amount（INVOICE＋CREDIT＋CHARGE；OUTSTANDING 只計 CURRENT）
//     = statedTotal（OUTSTANDING = statedCurrent）；差超過 $0.01 → 擋
//     （「月結單讀數唔齊（差 $X），可能有行影唔到」）
// 寫：CONFIRMED＋confirmedBy/At；audit LAB_STATEMENT_RECONCILE（結果數量、statedTotal、systemTotal、差額）
// 全部分段 CONFIRMED → 文件 RECONCILED。
// 權限：lab_statement（§10.2：確認）
// ownership-ok: labdoc 全集團範圍（B16）；section 必屬呢個 doc（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { sectionDuplicateBlock } from '@/lib/labdoc/statement-sections'
import { labdocAudit } from '@/lib/labdoc/audit'

const SECTION_ID_RE = /^[a-z0-9]{25}$/
const DOC_ID_RE = /^[a-z0-9]{25}$/

const OK_RESULTS = new Set(['MATCHED', 'PREVIOUSLY_MATCHED', 'NOT_APPLICABLE'])
const AMOUNT_LINE_TYPES = new Set(['INVOICE', 'CREDIT', 'CHARGE'])
const EPS = 0.01

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
    select: { id: true, kind: true, status: true, statementMonth: true, labId: true, createdAt: true },
  })
  if (!doc || doc.status === 'VOID') {
    return jsonNoStore({ error: '單據唔存在或已作廢' }, { status: 404 })
  }
  if (doc.kind !== 'STATEMENT') {
    return jsonNoStore({ error: '呢張單唔係月結單' }, { status: 400 })
  }
  if (doc.status === 'SUPERSEDED') {
    return jsonNoStore({ error: '呢張單已取代，唔可以再確認' }, { status: 409 })
  }

  const section = await prisma.labStatementSection.findFirst({
    where: { id: params.sid, documentId: doc.id },
    include: { lines: { orderBy: { lineIndex: 'asc' } } },
  })
  if (!section) {
    return jsonNoStore({ error: '分段唔屬於呢張單' }, { status: 404 })
  }
  if (section.status === 'CONFIRMED') {
    return jsonNoStore({ error: '分段已經確認' }, { status: 409 })
  }
  if (!doc.statementMonth) {
    return jsonNoStore({ error: '文件無 statementMonth，先完成識別' }, { status: 400 })
  }
  // §8.1：重複分段唔准確認（要先取代舊版）— 2026-10-10 模擬：兩份同月月結單都確認咗
  const dupMsg = await sectionDuplicateBlock(prisma, doc, section)
  if (dupMsg) return jsonNoStore({ error: dupMsg, code: 'SECTION_DUPLICATE' }, { status: 409 })

  const profile = doc.labId ? await prisma.labProfile.findUnique({ where: { labId: doc.labId } }) : null
  const stmtKind = profile?.statementKind === 'DETAIL' || profile?.statementKind === 'OUTSTANDING' ? profile.statementKind : 'INVOICE_LIST'

  // ① 每行已解決
  const unresolved = section.lines.filter(
    (l) => !OK_RESULTS.has(l.result) && l.resolution === null,
  )
  if (unresolved.length > 0) {
    return jsonNoStore(
      { error: `仲有 ${unresolved.length} 行未處理`, unresolvedCount: unresolved.length },
      { status: 400 },
    )
  }

  // ② §5.5 分段讀數檢查
  const stmtMonth = doc.statementMonth
  const isOutstanding = stmtKind === 'OUTSTANDING'
  const amountLines = section.lines.filter((l) => {
    if (!AMOUNT_LINE_TYPES.has(l.lineType)) return false
    if (isOutstanding) {
      // CURRENT = AI agingBucket（優先）；整段冇 bucket（AI 未讀 aging）先 fallback 日期
      const anyBucket = section.lines.some((x) => x.agingBucket != null)
      if (anyBucket) return l.agingBucket === 'CURRENT'
      return l.date ? sameMonth(l.date, stmtMonth) : false
    }
    return true
  })
  const sum = Math.round(amountLines.reduce((s, l) => s + Number(l.amount), 0) * 100) / 100
  const stated = isOutstanding ? (section.statedCurrent != null ? Number(section.statedCurrent) : null) : section.statedTotal != null ? Number(section.statedTotal) : null
  if (stated == null) {
    return jsonNoStore({ error: '分段總數未讀到，先補人工讀數' }, { status: 400 })
  }
  const diff = Math.round((sum - stated) * 100) / 100
  if (Math.abs(diff) > EPS) {
    return jsonNoStore(
      { error: `月結單讀數唔齊（差 $${Math.abs(diff)}），可能有行影唔到`, difference: diff },
      { status: 400 },
    )
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null

  // CONFIRMED（optimistic：已 CONFIRMED 嘅分段唔會再改）
  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.labStatementSection.updateMany({
      where: { id: section.id, documentId: doc.id, status: { not: 'CONFIRMED' } },
      data: { status: 'CONFIRMED', confirmedBy: session.userId, confirmedAt: new Date() },
    })
    if (res.count === 0) return null

    // 全部分段 CONFIRMED → 文件 RECONCILED
    const siblings = await tx.labStatementSection.findMany({ where: { documentId: doc.id }, select: { status: true } })
    const allConfirmed = siblings.length > 0 && siblings.every((s) => s.status === 'CONFIRMED')
    if (allConfirmed && (doc.status === 'IN_PROGRESS' || doc.status === 'NEEDS_REVIEW')) {
      await tx.labDocument.update({ where: { id: doc.id }, data: { status: 'RECONCILED' } })
    }
    return { allConfirmed }
  })
  if (!updated) {
    return jsonNoStore({ error: '分段已經確認' }, { status: 409 })
  }

  // audit（tx 後）
  const resultJson: any = section.resultJson ?? {}
  const counts = resultJson.counts ?? {}
  const systemTotal = section.systemTotal == null ? null : Number(section.systemTotal)
  const totalDiff = systemTotal == null ? null : Math.round((systemTotal - stated) * 100) / 100
  labdocAudit({
    action: 'LAB_STATEMENT_RECONCILE',
    entity: 'LabStatementSection',
    entityId: section.id,
    actorId: session.userId,
    clinicId: section.clinicId,
    before: null,
    after: {
      sectionId: section.id,
      documentId: doc.id,
      status: 'CONFIRMED',
      counts,
      statedTotal: stated,
      systemTotal,
      totalDiff,
      docStatusAfter: updated.allConfirmed ? 'RECONCILED' : doc.status,
    },
    ipAddress: ip,
    userAgent: ua,
  })

  return NextResponse.json({ ok: true, sectionId: section.id, status: 'CONFIRMED', documentStatus: updated.allConfirmed ? 'RECONCILED' : doc.status })
}

function sameMonth(d: Date, ym: string): boolean {
  return d.getUTCFullYear() === Number(ym.slice(0, 4)) && d.getUTCMonth() + 1 === Number(ym.slice(5, 7))
}
