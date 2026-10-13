// ★ 2026-10-13：POST /api/lab-docs/:id/sections/:sid/lines — 月結單人手加一行（AI 讀漏）
//
// body：{ amount（必填）, docNo?, date?（YYYY-MM-DD）, description?, patientCode?, note?, version, allowDuplicate? }
//  - 單號同 Lab 其他有效月結單已經有 → 409 DUPLICATE_DOCNO（UI 問用家；allowDuplicate=true 先加）
//  - 鎖：見 lib/labdoc/statement-line-edit.ts（已確認／作廢／版本）
//  - lineIndex：transaction 入面先鎖分段（SELECT … FOR UPDATE），唔會兩個人同時加撞 index
//  - 加完即刻重新對數
// 權限：lab_statement；audit：LAB_STATEMENT_LINE_ADD（金額、單號、項目；唔記病人編號）
// ownership-ok: labdoc 全集團範圍（B16）；section 必屬呢個 doc（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'
import { reconcileSection } from '@/lib/labdoc/statement-reconcile'
import { parseLineInput, loadEditableSection, findDocNoElsewhere, docNoOf } from '@/lib/labdoc/statement-line-edit'

export async function POST(req: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  let body: any
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  const loaded = await loadEditableSection(prisma, { docId: params.id, sid: params.sid, session, perms, version: body?.version })
  if ('res' in loaded) return loaded.res
  const { doc, section } = loaded
  const parsed = parseLineInput(body, { requireAmount: true })
  if ('error' in parsed) return jsonNoStore({ error: parsed.error }, { status: 400 })
  const { input, note } = parsed
  const docNo = docNoOf(input.docNoRaw)

  if (docNo && body?.allowDuplicate !== true) {
    const dup = await findDocNoElsewhere(prisma, { labId: doc.labId, docNo })
    if (dup) {
      return jsonNoStore({ error: `單號 ${input.docNoRaw} 已經喺${dup.month ? ` ${dup.month} ` : ''}月結單出現過 — 確定唔係重複先加`, code: 'DUPLICATE_DOCNO', month: dup.month }, { status: 409 })
    }
  }

  const now = new Date()
  const created = await prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT "id" FROM "LabStatementSection" WHERE "id" = ${section.id} FOR UPDATE`
    const v = await tx.labDocument.updateMany({ where: { id: doc.id, version: doc.version }, data: { version: { increment: 1 } } })
    if (v.count === 0) return null
    const max = await tx.labStatementLine.aggregate({ where: { sectionId: section.id }, _max: { lineIndex: true } })
    return tx.labStatementLine.create({
      data: {
        sectionId: section.id,
        lineIndex: (max?._max?.lineIndex ?? -1) + 1,
        lineType: (input.amount as number) < 0 ? 'CREDIT' : 'INVOICE',
        amount: input.amount as number,
        docNoRaw: input.docNoRaw ?? null,
        docNo,
        date: input.date ?? null,
        description: input.description ?? null,
        patientCode: input.patientCode ?? null,
        manualSource: 'ADDED',
        manualBy: session.userId,
        manualAt: now,
        manualNote: note,
      },
      select: { id: true },
    })
  })
  if (!created) return jsonNoStore({ error: '版本衝突（單據已更新）— 請重新載入', code: 'VERSION' }, { status: 409 })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  await labdocAudit({
    action: 'LAB_STATEMENT_LINE_ADD',
    entity: 'LabStatementLine',
    entityId: created.id,
    clinicId: section.clinicId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: `人手加行（doc ${doc.id}，段 ${section.sectionIndex}）${note ? `：${note}` : ''}`,
    after: { amount: input.amount, docNoRaw: input.docNoRaw ?? null, date: body?.date ?? null, description: input.description ?? null, hasPatientCode: !!input.patientCode, allowDuplicate: body?.allowDuplicate === true },
  })

  const r = await reconcileSection(prisma, { sectionId: section.id, actorId: session.userId, source: 'manual', ipAddress: ip, userAgent: ua })
  return NextResponse.json({
    ok: true,
    lineId: created.id,
    reconcile: r.ok ? { status: r.sectionStatus, statementTotal: r.statementTotal, costTotal: r.costTotal, diff: r.diff } : { error: r.message, code: r.code },
  })
}
