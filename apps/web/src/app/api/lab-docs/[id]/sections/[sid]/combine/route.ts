// ★ cwm-labdoc：POST /api/lab-docs/:id/sections/:sid/combine — 「兩份加埋一齊對」（2026-10-12 用家拍板）
//
// 同一位醫生、同一間 Lab、同一個月有兩份月結單，而且唔係 Lab 重發（重發用「取代舊版」）。
// 呢段（後上傳嗰份）combineWithSectionId → 較早嗰段；之後成組一齊對數（行加埋、成本只計一次）、一齊確認。
//
// body：{ resetConfirmed?: boolean }
//  - 組入面有段已經確認咗 → 409 GROUP_CONFIRMED（UI 問用家）；resetConfirmed=true → 嗰啲段打返未確認
//    （文件 RECONCILED → IN_PROGRESS），加埋後要重新確認。audit 記低。
// 權限：lab_statement；audit：LAB_STATEMENT_COMBINE（段 id、文件 id、打返未確認嘅段；零病人資料）
// ownership-ok: labdoc 全集團範圍（B16）；section 必屬呢個 doc、合併對象由伺服器按同範圍搵（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'
import { reconcileSection, afterCarryChange } from '@/lib/labdoc/statement-reconcile'
import { findStatementSectionDuplicate } from '@/lib/labdoc/statement-sections'
import { sectionCombineGroup, groupFromScope, unconfirmSections } from '@/lib/labdoc/statement-combine'
import { labdocScope, kioskDocGuard } from '@/lib/labdoc/kiosk-scope'

const ID_RE = /^[a-z0-9]{25}$/
const INACTIVE_DOC = ['VOID', 'SUPERSEDED', 'DUPLICATE']

export async function POST(req: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth
  const kioskDeny = await kioskDocGuard(session, params.id)
  if (kioskDeny) return kioskDeny
  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }
  if (!ID_RE.test(params.id) || !ID_RE.test(params.sid)) {
    return jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 })
  }
  let body: { resetConfirmed?: unknown } = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const resetConfirmed = body.resetConfirmed === true

  const scope = await labdocScope(session, perms)
  if (scope !== null && scope.length === 0) return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })

  const doc = await prisma.labDocument.findUnique({
    where: { id: params.id },
    select: { id: true, kind: true, status: true, labId: true, statementMonth: true, createdAt: true },
  })
  if (!doc || doc.kind !== 'STATEMENT' || INACTIVE_DOC.includes(doc.status)) {
    return jsonNoStore({ error: '單據唔存在或唔係有效月結單' }, { status: 404 })
  }
  const section = await prisma.labStatementSection.findFirst({
    where: { id: params.sid, documentId: doc.id },
    select: { id: true, clinicId: true, providerId: true, status: true, combineWithSectionId: true },
  })
  if (!section) return jsonNoStore({ error: '分段唔屬於呢張單' }, { status: 404 })
  if (scope !== null && section.clinicId && !scope.includes(section.clinicId)) {
    return jsonNoStore({ error: '診所唔喺你嘅範圍' }, { status: 403 })
  }
  if (!doc.labId || !doc.statementMonth || !section.clinicId || !section.providerId) {
    return jsonNoStore({ error: '分段未揀齊 Lab／月份／診所／醫生' }, { status: 400 })
  }

  // 合併對象：伺服器自己搵（較早、同範圍、未入組）
  const existingGroup = await sectionCombineGroup(prisma, section.id)
  const dup = await findStatementSectionDuplicate(prisma, {
    labId: doc.labId,
    clinicId: section.clinicId,
    providerId: section.providerId,
    statementMonth: doc.statementMonth,
    selfDocId: doc.id,
    selfCreatedAt: doc.createdAt,
    excludeSectionIds: existingGroup?.memberIds,
  })
  if (!dup) {
    return jsonNoStore({ error: '冇另一份更早上傳、同 Lab／診所／醫生／月嘅月結單可以加埋' }, { status: 400 })
  }

  // 加埋之後嘅組 = 而家範圍內嘅組 ＋ 呢段 ＋ 對象（模擬計，睇有冇已確認）
  const scopeRows: any[] = await prisma.labStatementSection.findMany({
    where: {
      clinicId: section.clinicId,
      providerId: section.providerId,
      document: { kind: 'STATEMENT', labId: doc.labId, statementMonth: doc.statementMonth, status: { notIn: INACTIVE_DOC } },
    },
    select: { id: true, documentId: true, combineWithSectionId: true, status: true, document: { select: { createdAt: true, status: true } } },
  })
  const simulated = scopeRows.map((r) => (r.id === section.id ? { ...r, combineWithSectionId: dup.sectionId } : r))
  const future = groupFromScope(simulated)
  if (!future || !future.memberIds.includes(section.id) || !future.memberIds.includes(dup.sectionId)) {
    return jsonNoStore({ error: '加埋失敗（範圍唔一致）— 請重新載入' }, { status: 409 })
  }
  const confirmedIds = scopeRows.filter((r) => future.memberIds.includes(r.id) && r.status === 'CONFIRMED').map((r) => r.id)
  if (confirmedIds.length > 0 && !resetConfirmed) {
    return jsonNoStore({
      error: '另一份月結單已經確認咗 — 加埋之後要重新確認，確定要加埋？',
      code: 'GROUP_CONFIRMED',
      confirmedSectionIds: confirmedIds,
    }, { status: 409 })
  }

  await prisma.$transaction(async (tx: any) => {
    await unconfirmSections(tx, confirmedIds)
    await tx.labStatementSection.update({ where: { id: section.id }, data: { combineWithSectionId: dup.sectionId } })
  })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  await labdocAudit({
    action: 'LAB_STATEMENT_COMBINE',
    entity: 'LabStatementSection',
    entityId: section.id,
    clinicId: section.clinicId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: `兩份加埋一齊對：段 ${section.id}（doc ${doc.id}）→ 段 ${dup.sectionId}（doc ${dup.docId}）`,
    before: { combineWithSectionId: section.combineWithSectionId, confirmedSectionIds: confirmedIds },
    after: { combineWithSectionId: dup.sectionId, groupSectionIds: future.memberIds, unconfirmedSectionIds: confirmedIds },
  })

  const r = await reconcileSection(prisma, { sectionId: section.id, actorId: session.userId, source: 'manual', ipAddress: ip, userAgent: ua })
  // 組變咗 → 結轉只入主段；下個月結轉都同步
  await afterCarryChange(prisma, { sectionIds: future.memberIds }, session.userId)
  return NextResponse.json({
    ok: true,
    groupSectionIds: future.memberIds,
    unconfirmedSectionIds: confirmedIds,
    reconcile: r.ok ? { status: r.sectionStatus, statementTotal: r.statementTotal, costTotal: r.costTotal, diff: r.diff } : { error: r.message, code: r.code },
  })
}
