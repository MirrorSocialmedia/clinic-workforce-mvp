// ★ cwm-labdoc：POST /api/lab-docs/:id/sections/:sid/lines/:lid/resolve — 月結單行標記
//
// 2026-10-11 改：月結單同「成本錄入」對總數（statement-reconcile.ts）；行唔再逐張 invoice 處理。
// 行只有兩種標記，標咗就唔計入同成本錄入比較嘅總數：
//
// | resolution | 意思 |
// | STOCK      | 備貨：診所向 Lab 買嘅器材，唔屬病人、唔會入成本錄入（原因可選）
// | NOT_OURS   | 唔關我哋事（例如第二間診所嘅單）— 要原因
// | CLEAR      | 取消標記
//
// body：{ resolution, note?, applyToAll? } — applyToAll=true：成段所有計數行一齊標（例如成段都係備貨）；
//   :lid 仍然要係呢段嘅行（防 IDOR）。
// 「以月結單為準」改過系統嘅行（舊 STATEMENT_WINS）唔可以再改。
// 標完即刻重新對數。
// 權限：lab_statement；audit：LAB_STATEMENT_RESOLVE（行數、標記、原因；零病人資料）
// ownership-ok: labdoc 全集團範圍（B16）；line.section=section.document=doc（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'
import { reconcileSection } from '@/lib/labdoc/statement-reconcile'
import { sectionDuplicateBlock } from '@/lib/labdoc/statement-sections'
import { labdocScope, kioskDocGuard } from '@/lib/labdoc/kiosk-scope'

const ID_RE = /^[a-z0-9]{25}$/
const RESOLUTIONS = ['STOCK', 'NOT_OURS', 'CLEAR'] as const
type Resolution = (typeof RESOLUTIONS)[number]
const COUNTED_TYPES = ['INVOICE', 'CREDIT', 'CHARGE']

export async function POST(req: NextRequest, { params }: { params: { id: string; sid: string; lid: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth
  // ★ KIOSK 只可以處理自己店嘅單（kiosk-scope.ts）
  const kioskDeny = await kioskDocGuard(session, params.id)
  if (kioskDeny) return kioskDeny

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }
  if (![params.id, params.sid, params.lid].every((x) => ID_RE.test(x))) {
    return jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 })
  }

  let body: { resolution?: string; note?: string | null; applyToAll?: boolean }
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  const { resolution, applyToAll = false } = body
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (!RESOLUTIONS.includes(resolution as Resolution)) {
    return jsonNoStore({ error: 'resolution 必須係 STOCK／NOT_OURS／CLEAR' }, { status: 400 })
  }
  if (resolution === 'NOT_OURS' && note.length === 0) {
    return jsonNoStore({ error: '「唔關我哋事」要寫原因' }, { status: 400 })
  }
  if (note.length > 200) {
    return jsonNoStore({ error: '原因最多 200 字' }, { status: 400 })
  }

  const scope = await labdocScope(session, perms)
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  // —— 載入（防 IDOR）——
  const doc = await prisma.labDocument.findUnique({
    where: { id: params.id },
    select: { id: true, kind: true, status: true, labId: true, statementMonth: true, createdAt: true },
  })
  if (!doc || doc.status === 'VOID' || doc.kind !== 'STATEMENT') {
    return jsonNoStore({ error: '單據唔存在或唔係月結單' }, { status: 404 })
  }
  if (doc.status === 'SUPERSEDED') {
    return jsonNoStore({ error: '呢張月結單已被取代 — 請喺新版處理' }, { status: 409 })
  }
  const section = await prisma.labStatementSection.findFirst({
    where: { id: params.sid, documentId: doc.id },
    select: { id: true, clinicId: true, providerId: true, status: true, sectionIndex: true },
  })
  if (!section) return jsonNoStore({ error: '分段唔屬於呢張單' }, { status: 404 })
  if (section.status === 'CONFIRMED') {
    return jsonNoStore({ error: '分段已確認 — 唔可以再改' }, { status: 409 })
  }
  if (scope !== null && section.clinicId && !scope.includes(section.clinicId)) {
    return jsonNoStore({ error: '診所唔喺你嘅範圍' }, { status: 403 })
  }
  const line = await prisma.labStatementLine.findFirst({
    where: { id: params.lid, sectionId: section.id },
    select: { id: true, resolution: true, lineType: true },
  })
  if (!line) return jsonNoStore({ error: '行唔屬於呢個分段' }, { status: 404 })
  const dupMsg = await sectionDuplicateBlock(prisma, doc, section)
  if (dupMsg) return jsonNoStore({ error: dupMsg, code: 'SECTION_DUPLICATE' }, { status: 409 })

  const targets = applyToAll
    ? await prisma.labStatementLine.findMany({
        where: { sectionId: section.id, lineType: { in: COUNTED_TYPES } },
        select: { id: true, resolution: true },
      })
    : [line]
  if (targets.some((t) => t.resolution === 'STATEMENT_WINS')) {
    return jsonNoStore({ error: '有行之前用「以月結單為準」改咗系統 — 唔可以再改標記' }, { status: 409 })
  }

  const now = new Date()
  const ids = targets.map((t) => t.id)
  await prisma.labStatementLine.updateMany({
    where: { id: { in: ids }, sectionId: section.id },
    data:
      resolution === 'CLEAR'
        ? { resolution: null, resolutionNote: null, resolvedBy: null, resolvedAt: null }
        : { resolution, resolutionNote: note || null, resolvedBy: session.userId, resolvedAt: now },
  })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  await labdocAudit({
    action: 'LAB_STATEMENT_RESOLVE',
    entity: 'LabStatementSection',
    entityId: section.id,
    clinicId: section.clinicId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: `${resolution}${applyToAll ? '（成段）' : ''}：${ids.length} 行（doc ${doc.id}，段 ${section.sectionIndex}）`,
    after: { resolution, note: note || null, lineIds: ids, applyToAll },
  })

  // 標完即刻重新對數（未有 Lab／月份／診所醫生 → 留低，下次對數先計）
  const r = await reconcileSection(prisma, { sectionId: section.id, actorId: session.userId, source: 'manual', ipAddress: ip, userAgent: ua })
  return NextResponse.json({
    ok: true,
    updated: ids.length,
    resolution,
    reconcile: r.ok ? { status: r.sectionStatus, statementTotal: r.statementTotal, costTotal: r.costTotal, diff: r.diff } : { error: r.message, code: r.code },
  })
}
