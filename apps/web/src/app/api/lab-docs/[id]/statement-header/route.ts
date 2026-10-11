// ★ cwm-labdoc：PUT /api/lab-docs/:id/statement-header — 月結單人手揀 Lab／月份
//
// 讀單讀唔到 Lab 或者月份（「Lab 未識別 · 月份未識別」）→ 對數會報「文件無 statementMonth」。
// 呢度俾經理人手補／改返。body：{ labId?, statementMonth?（YYYY-MM）, version }
// - 只寫傳入嘅欄位；有改先寫
// - 有分段已確認 → 409（確認咗嘅結果基於舊 Lab／月份）
// - 有行「以月結單為準」改咗系統 → 409（statement-reset.ts）
// - 改咗（舊值非空）→ 全部分段清配對＋差異處理；之後診所＋醫生齊嘅分段自動重新配對
// - 清走「月份由行日期推斷」標黃（人手揀咗）
// 權限：lab_statement；版本守衛：doc.version optimistic lock
// audit：LAB_STATEMENT_HEADER（before/after = labId／statementMonth，零病人資料）
// ownership-ok: labdoc 全集團範圍（B16）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'
import { autoReconcileIfReady } from '@/lib/labdoc/statement-reconcile'
import { resetSectionMatching, sectionsWithSystemChange, SYSTEM_CHANGE_BLOCK_MSG } from '@/lib/labdoc/statement-reset'
import { checkPayeeNew } from '@/lib/labdoc/identify'
import { labdocScope, kioskDocGuard } from '@/lib/labdoc/kiosk-scope'

const DOC_ID_RE = /^[a-z0-9]{25}$/
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const EDITABLE = new Set(['NEEDS_REVIEW', 'IN_PROGRESS'])

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth
  // ★ KIOSK 只可以處理自己店嘅單（kiosk-scope.ts）
  const kioskDeny = await kioskDocGuard(session, params.id)
  if (kioskDeny) return kioskDeny

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }
  if (!DOC_ID_RE.test(params.id)) {
    return jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 })
  }

  let body: { labId?: unknown; statementMonth?: unknown; version?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  const { version } = body
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return jsonNoStore({ error: 'version 必須係非負整數（optimistic lock）' }, { status: 400 })
  }
  if (body.labId !== undefined && (typeof body.labId !== 'string' || body.labId.length === 0 || body.labId.length > 64)) {
    return jsonNoStore({ error: 'labId 格式錯誤' }, { status: 400 })
  }
  if (body.statementMonth !== undefined && (typeof body.statementMonth !== 'string' || !MONTH_RE.test(body.statementMonth))) {
    return jsonNoStore({ error: '月份格式要係 YYYY-MM' }, { status: 400 })
  }
  const labId = body.labId as string | undefined
  const statementMonth = body.statementMonth as string | undefined
  if (labId === undefined && statementMonth === undefined) {
    return jsonNoStore({ error: 'labId／statementMonth 至少要傳一個' }, { status: 400 })
  }

  const scope = await labdocScope(session, perms)
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  const doc = await prisma.labDocument.findUnique({
    where: { id: params.id },
    select: {
      id: true, kind: true, status: true, version: true, labId: true, statementMonth: true, readIssues: true, supersededById: true, payeeRaw: true,
      sections: { select: { id: true, status: true, clinicId: true, providerId: true } },
    },
  })
  if (!doc || doc.status === 'VOID') {
    return jsonNoStore({ error: '單據唔存在或已作廢' }, { status: 404 })
  }
  if (doc.kind !== 'STATEMENT') {
    return jsonNoStore({ error: '呢張單唔係月結單' }, { status: 400 })
  }
  if (doc.supersededById || !EDITABLE.has(doc.status)) {
    return jsonNoStore({ error: '呢張月結單而家唔可以改 Lab／月份' }, { status: 409 })
  }
  if (doc.version !== version) {
    return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
  }
  if (labId !== undefined) {
    const lab = await prisma.lab.findUnique({ where: { id: labId }, select: { id: true } })
    if (!lab) return jsonNoStore({ error: 'Lab 唔存在' }, { status: 400 })
  }

  const labChanged = labId !== undefined && labId !== doc.labId
  const monthChanged = statementMonth !== undefined && statementMonth !== doc.statementMonth
  if (!labChanged && !monthChanged) {
    return NextResponse.json({ ok: true, changed: false, labId: doc.labId, statementMonth: doc.statementMonth })
  }
  if (doc.sections.some((s) => s.status === 'CONFIRMED')) {
    return jsonNoStore({ error: '有分段已確認 — 唔可以再改 Lab／月份' }, { status: 409 })
  }
  const sectionIds = doc.sections.map((s) => s.id)
  // 之前有 Lab＋月份先可能配對過；舊值係空 → 未配對過，唔使清
  const hadBasis = doc.labId !== null && doc.statementMonth !== null
  if (hadBasis && (await sectionsWithSystemChange(prisma, sectionIds)) > 0) {
    return jsonNoStore({ error: SYSTEM_CHANGE_BLOCK_MSG }, { status: 409 })
  }

  // ★ 2026-10-11：改咗 Lab → 收款人要對新 Lab 再判斷（之前一直留住舊結果）
  const payeeIsNew = labChanged ? await checkPayeeNew(prisma, labId as string, doc.payeeRaw) : undefined

  const ok = await prisma.$transaction(async (tx: any) => {
    if (hadBasis) await resetSectionMatching(tx, sectionIds)
    const d = await tx.labDocument.updateMany({
      where: { id: doc.id, version },
      data: {
        ...(labChanged ? { labId, payeeIsNew } : {}),
        ...(monthChanged ? { statementMonth } : {}),
        ...(monthChanged ? { readIssues: doc.readIssues.filter((x) => x !== 'STATEMENT_MONTH_FROM_LINES') } : {}),
        version: { increment: 1 },
      },
    })
    if (d.count === 0) throw new Error('VERSION')
    return true
  }, { timeout: 30_000 }).catch((e: Error) => {
    if (e.message === 'VERSION') return false
    throw e
  })
  if (!ok) {
    return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  await labdocAudit({
    action: 'LAB_STATEMENT_HEADER',
    entity: 'LabDocument',
    entityId: doc.id,
    clinicId: null,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: `statement header（doc ${doc.id}）`,
    before: { labId: doc.labId, statementMonth: doc.statementMonth },
    after: {
      labId: labChanged ? labId : doc.labId,
      statementMonth: monthChanged ? statementMonth : doc.statementMonth,
      matchingReset: hadBasis,
    },
  })

  // 診所＋醫生齊嘅分段 → 自動重新配對（best-effort；失敗留 PENDING，可以喺分段頁撳「重新配對」）
  let reconciled = 0
  for (const s of doc.sections) {
    if (!s.clinicId || !s.providerId) continue
    const r = await autoReconcileIfReady(prisma, s.id, session.userId, 'auto', '[labdoc:statement-header]')
    if (r?.ok) reconciled++
  }
  return NextResponse.json({
    ok: true,
    changed: true,
    labId: labChanged ? labId : doc.labId,
    statementMonth: monthChanged ? statementMonth : doc.statementMonth,
    reconciled,
  })
}
