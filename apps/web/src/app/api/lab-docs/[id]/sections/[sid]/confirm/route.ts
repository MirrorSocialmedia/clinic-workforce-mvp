// ★ cwm-labdoc：POST /api/lab-docs/:id/sections/:sid/confirm — 確認月結單分段
//
// 2026-10-11 改：月結單同「成本錄入」對總數（statement-reconcile.ts）。
// 確認前先用最新成本錄入重新對一次數：
//  - 總數一致（OK）而且讀數檢查冇問題 → 直接確認
//  - 有差異（DIFF）→ body.reason 必填（≤200 字），寫入 section.note
//  - ★ 2026-10-11：「印嘅總數 vs 行加埋」唔再要原因 — 月結單冇印總數時 AI 會自己加錯一個數出嚟
//    （HC 9 月 Dr.Tse：行同成本錄入都係 $12,400，AI 作咗個 $11,780），總數一致仲要寫原因只會誤導
// 寫：CONFIRMED＋confirmedBy/At；audit LAB_STATEMENT_RECONCILE（月結單總數、成本總數、差額、原因）
// 全部分段 CONFIRMED → 文件 RECONCILED。
// 權限：lab_statement（§10.2：確認）
// ownership-ok: labdoc 全集團範圍（B16）；section 必屬呢個 doc（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { sectionDuplicateBlock } from '@/lib/labdoc/statement-sections'
import { reconcileSection } from '@/lib/labdoc/statement-reconcile'
import { labdocAudit } from '@/lib/labdoc/audit'
import { labdocScope, kioskDocGuard } from '@/lib/labdoc/kiosk-scope'

const SECTION_ID_RE = /^[a-z0-9]{25}$/
const DOC_ID_RE = /^[a-z0-9]{25}$/

export async function POST(req: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth
  // ★ KIOSK 只可以處理自己店嘅單（kiosk-scope.ts）
  const kioskDeny = await kioskDocGuard(session, params.id)
  if (kioskDeny) return kioskDeny

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }
  if (!DOC_ID_RE.test(params.id) || !SECTION_ID_RE.test(params.sid)) {
    return jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 })
  }
  let body: { reason?: unknown } = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length > 200) {
    return jsonNoStore({ error: '原因最多 200 字' }, { status: 400 })
  }

  const scope = await labdocScope(session, perms)
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
    select: { id: true, status: true, clinicId: true, providerId: true },
  })
  if (!section) {
    return jsonNoStore({ error: '分段唔屬於呢張單' }, { status: 404 })
  }
  if (section.status === 'CONFIRMED') {
    return jsonNoStore({ error: '分段已經確認' }, { status: 409 })
  }
  if (scope !== null && section.clinicId && !scope.includes(section.clinicId)) {
    return jsonNoStore({ error: '診所唔喺你嘅範圍' }, { status: 403 })
  }
  // §8.1：重複分段唔准確認（要先取代舊版）
  const dupMsg = await sectionDuplicateBlock(prisma, doc, section)
  if (dupMsg) return jsonNoStore({ error: dupMsg, code: 'SECTION_DUPLICATE' }, { status: 409 })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null

  // 用最新成本錄入再對一次（成本錄入可能啱啱改過）
  const r = await reconcileSection(prisma, { sectionId: section.id, actorId: session.userId, source: 'manual', ipAddress: ip, userAgent: ua })
  if (!r.ok) {
    return jsonNoStore({ error: r.message, code: r.code }, { status: r.code === 'NOT_FOUND' || r.code === 'CONFIRMED' ? 409 : 400 })
  }
  const needsReason = r.sectionStatus === 'DIFF'
  if (needsReason && reason.length === 0) {
    const why = `月結單 $${r.statementTotal} 同成本錄入 $${r.costTotal} 差 $${Math.abs(r.diff)}`
    return jsonNoStore({ error: `${why} — 要寫原因先可以確認`, code: 'REASON_REQUIRED', diff: r.diff }, { status: 400 })
  }

  // CONFIRMED（optimistic：已 CONFIRMED 嘅分段唔會再改）
  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.labStatementSection.updateMany({
      where: { id: section.id, documentId: doc.id, status: { not: 'CONFIRMED' } },
      data: { status: 'CONFIRMED', confirmedBy: session.userId, confirmedAt: new Date(), ...(needsReason ? { note: reason } : {}) },
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
      statementTotal: r.statementTotal,
      costTotal: r.costTotal,
      totalDiff: r.diff,
      reason: needsReason ? reason : null,
      docStatusAfter: updated.allConfirmed ? 'RECONCILED' : doc.status,
    },
    ipAddress: ip,
    userAgent: ua,
  })

  return NextResponse.json({ ok: true, sectionId: section.id, status: 'CONFIRMED', documentStatus: updated.allConfirmed ? 'RECONCILED' : doc.status })
}
