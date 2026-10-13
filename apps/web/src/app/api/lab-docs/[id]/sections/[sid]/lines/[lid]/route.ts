// ★ 2026-10-13：PATCH／DELETE /api/lab-docs/:id/sections/:sid/lines/:lid — 月結單人手改行／刪行
//
// PATCH body：{ amount?, docNo?, date?, description?, patientCode?, note?, version, allowDuplicate? }
//  - AI 讀嘅行第一次改 → aiOriginal 記低 AI 原值（之後再改都唔會蓋）；manualSource = EDITED（人手加嘅行維持 ADDED）
//  - 改單號 → 同 Lab 其他有效月結單有同一個單號 → 409 DUPLICATE_DOCNO（allowDuplicate=true 先改）
// DELETE body：{ version, note? } — 只可以刪人手加嘅行（AI 讀嘅行用「唔關我哋事／備貨」）
// 鎖：lib/labdoc/statement-line-edit.ts（已確認／作廢／版本／結轉副本／計入下個月／人手配對／以月結單為準）
// 改完即刻重新對數。權限：lab_statement；audit：LAB_STATEMENT_LINE_EDIT／LAB_STATEMENT_LINE_DELETE（唔記病人編號值）
// ownership-ok: labdoc 全集團範圍（B16）；line.section=section.document=doc（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'
import { reconcileSection } from '@/lib/labdoc/statement-reconcile'
import { ID_RE, parseLineInput, loadEditableSection, lineEditBlock, findDocNoElsewhere, docNoOf } from '@/lib/labdoc/statement-line-edit'

const LINE_SELECT = {
  id: true, sectionId: true, amount: true, docNoRaw: true, docNo: true, date: true, description: true, patientCode: true,
  carriedFromLineId: true, resolution: true, pairMode: true, manualSource: true, aiOriginal: true, lineType: true,
}
const ymd = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null)

async function load(req: NextRequest, params: { id: string; sid: string; lid: string }, method: 'PATCH' | 'DELETE') {
  const auth = await requireAuth(req, method, req.url)
  if (isAuthError(auth)) return { res: auth.error }
  const { session, perms } = auth
  let body: any
  try {
    body = await req.json()
  } catch {
    return { res: jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 }) }
  }
  if (!ID_RE.test(params.lid)) return { res: jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 }) }
  const loaded = await loadEditableSection(prisma, { docId: params.id, sid: params.sid, session, perms, version: body?.version })
  if ('res' in loaded) return { res: loaded.res }
  const line = await prisma.labStatementLine.findFirst({ where: { id: params.lid, sectionId: loaded.section.id }, select: LINE_SELECT })
  if (!line) return { res: jsonNoStore({ error: '行唔屬於呢個分段' }, { status: 404 }) }
  return { session, body, doc: loaded.doc, section: loaded.section, line }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string; sid: string; lid: string } }) {
  const l = await load(req, params, 'PATCH')
  if ('res' in l) return l.res
  const { session, body, doc, section, line } = l
  const parsed = parseLineInput(body, { requireAmount: false })
  if ('error' in parsed) return jsonNoStore({ error: parsed.error }, { status: 400 })
  const { input, note } = parsed

  // 只計真係改咗嘅欄位
  const changes: Record<string, unknown> = {}
  if (input.amount !== undefined && Math.abs(input.amount - Number(line.amount)) > 0.001) changes.amount = input.amount
  if (input.docNoRaw !== undefined && (input.docNoRaw ?? null) !== (line.docNoRaw ?? null)) {
    changes.docNoRaw = input.docNoRaw
    changes.docNo = docNoOf(input.docNoRaw)
  }
  if (input.date !== undefined && ymd(input.date) !== ymd(line.date)) changes.date = input.date
  if (input.description !== undefined && (input.description ?? null) !== (line.description ?? null)) changes.description = input.description
  if (input.patientCode !== undefined && (input.patientCode ?? null) !== (line.patientCode ?? null)) changes.patientCode = input.patientCode
  if (Object.keys(changes).length === 0) return jsonNoStore({ error: '冇改到任何嘢' }, { status: 400 })

  const block = lineEditBlock(line, { amountChanging: 'amount' in changes })
  if (block) return jsonNoStore({ error: block, code: 'LINE_LOCKED' }, { status: 409 })
  if (changes.amount !== undefined && line.lineType !== 'INVOICE' && line.lineType !== 'CREDIT' && line.lineType !== 'CHARGE') {
    return jsonNoStore({ error: '付款／上月結餘行唔可以改金額' }, { status: 409 })
  }
  if (changes.docNo && body?.allowDuplicate !== true) {
    const dup = await findDocNoElsewhere(prisma, { labId: doc.labId, docNo: changes.docNo as string, excludeLineId: line.id })
    if (dup) {
      return jsonNoStore({ error: `單號 ${changes.docNoRaw} 已經喺${dup.month ? ` ${dup.month} ` : ''}月結單出現過 — 確定唔係重複先改`, code: 'DUPLICATE_DOCNO', month: dup.month }, { status: 409 })
    }
  }

  const before = { amount: Number(line.amount), docNoRaw: line.docNoRaw, date: ymd(line.date), description: line.description }
  // AI 原值：第一次人手改先記（之後唔蓋）；人手加嘅行冇 AI 原值
  const aiOriginal = line.manualSource == null
    ? { amount: Number(line.amount), docNoRaw: line.docNoRaw, date: ymd(line.date), description: line.description, patientCode: line.patientCode }
    : undefined
  const ok = await prisma.$transaction(async (tx: any) => {
    const v = await tx.labDocument.updateMany({ where: { id: doc.id, version: doc.version }, data: { version: { increment: 1 } } })
    if (v.count === 0) return false
    const amountType = changes.amount !== undefined ? { lineType: (changes.amount as number) < 0 ? 'CREDIT' : line.lineType === 'CREDIT' ? 'INVOICE' : line.lineType } : {}
    const u = await tx.labStatementLine.updateMany({
      where: { id: line.id, sectionId: section.id, carriedFromLineId: null },
      data: {
        ...changes,
        ...amountType,
        manualSource: line.manualSource ?? 'EDITED',
        ...(aiOriginal ? { aiOriginal } : {}),
        manualBy: session.userId,
        manualAt: new Date(),
        manualNote: note,
      },
    })
    if (u.count === 0) throw new Error('LINE_GONE')
    return true
  }).catch((e: Error) => {
    if (e.message === 'LINE_GONE') return 'gone' as const
    throw e
  })
  if (ok === 'gone') return jsonNoStore({ error: '呢行已經唔喺度 — 請重新載入' }, { status: 409 })
  if (!ok) return jsonNoStore({ error: '版本衝突（單據已更新）— 請重新載入', code: 'VERSION' }, { status: 409 })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  const afterView: Record<string, unknown> = {}
  for (const k of ['amount', 'docNoRaw', 'description'] as const) if (k in changes) afterView[k] = changes[k]
  if ('date' in changes) afterView.date = ymd(changes.date as Date | null)
  if ('patientCode' in changes) afterView.patientCodeChanged = true
  await labdocAudit({
    action: 'LAB_STATEMENT_LINE_EDIT',
    entity: 'LabStatementLine',
    entityId: line.id,
    clinicId: section.clinicId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: `人手改行（doc ${doc.id}，段 ${section.sectionIndex}）${note ? `：${note}` : ''}`,
    before: Object.fromEntries(Object.keys(afterView).filter((k) => k in before).map((k) => [k, (before as any)[k]])),
    after: afterView,
  })

  const r = await reconcileSection(prisma, { sectionId: section.id, actorId: session.userId, source: 'manual', ipAddress: ip, userAgent: ua })
  return NextResponse.json({
    ok: true,
    reconcile: r.ok ? { status: r.sectionStatus, statementTotal: r.statementTotal, costTotal: r.costTotal, diff: r.diff } : { error: r.message, code: r.code },
  })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; sid: string; lid: string } }) {
  const l = await load(req, params, 'DELETE')
  if ('res' in l) return l.res
  const { session, body, doc, section, line } = l
  const block = lineEditBlock(line, { amountChanging: false, deleting: true })
  if (block) return jsonNoStore({ error: block, code: 'LINE_LOCKED' }, { status: 409 })
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 200) || null : null

  const ok = await prisma.$transaction(async (tx: any) => {
    const v = await tx.labDocument.updateMany({ where: { id: doc.id, version: doc.version }, data: { version: { increment: 1 } } })
    if (v.count === 0) return false
    const d = await tx.labStatementLine.deleteMany({ where: { id: line.id, sectionId: section.id, manualSource: 'ADDED', carriedFromLineId: null } })
    if (d.count === 0) throw new Error('LINE_GONE')
    return true
  }).catch((e: Error) => {
    if (e.message === 'LINE_GONE') return 'gone' as const
    throw e
  })
  if (ok === 'gone') return jsonNoStore({ error: '呢行已經唔喺度 — 請重新載入' }, { status: 409 })
  if (!ok) return jsonNoStore({ error: '版本衝突（單據已更新）— 請重新載入', code: 'VERSION' }, { status: 409 })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  await labdocAudit({
    action: 'LAB_STATEMENT_LINE_DELETE',
    entity: 'LabStatementLine',
    entityId: line.id,
    clinicId: section.clinicId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: `刪人手加嘅行（doc ${doc.id}，段 ${section.sectionIndex}）${note ? `：${note}` : ''}`,
    before: { amount: Number(line.amount), docNoRaw: line.docNoRaw, date: ymd(line.date), description: line.description },
  })

  const r = await reconcileSection(prisma, { sectionId: section.id, actorId: session.userId, source: 'manual', ipAddress: ip, userAgent: ua })
  return NextResponse.json({
    ok: true,
    reconcile: r.ok ? { status: r.sectionStatus, statementTotal: r.statementTotal, costTotal: r.costTotal, diff: r.diff } : { error: r.message, code: r.code },
  })
}
