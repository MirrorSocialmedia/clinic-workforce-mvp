// ★ cwm-labdoc P3：POST /api/lab-docs/:id/supersede — §8.1 取代舊版月結單
//
// body：{ oldDocumentId, reason, version }
// - 新文件 = :id（本單）；舊文件 → status=SUPERSEDED、supersededById=新 id（舊分段結果保留做紀錄）
// - reason 必填（≤500 字）
// 權限：lab_statement（§10.2：取代舊版）
// 版本守衛：新文件 doc.version optimistic lock
// audit：LAB_STATEMENT_SUPERSEDE（SPEC：舊 id、新 id、原因）
// ownership-ok: labdoc 全集團範圍（B16）；兩份文件存在＋未 VOID/SUPERSEDED（防 IDOR／重複取代）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { reconcileSection, afterCarryChange } from '@/lib/labdoc/statement-reconcile'
import { labdocAudit } from '@/lib/labdoc/audit'
import { labdocScope, kioskDocGuard } from '@/lib/labdoc/kiosk-scope'
import { otherGroupMembersOfDoc, unconfirmSections } from '@/lib/labdoc/statement-combine'

const DOC_ID_RE = /^[a-z0-9]{25}$/

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
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

  let body: { oldDocumentId?: string; reason?: string; version?: number }
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  const { oldDocumentId, reason, version } = body
  if (!oldDocumentId || !DOC_ID_RE.test(oldDocumentId)) {
    return jsonNoStore({ error: 'oldDocumentId 缺失或格式錯誤' }, { status: 400 })
  }
  if (oldDocumentId === params.id) {
    return jsonNoStore({ error: '唔可以用自己取代自己' }, { status: 400 })
  }
  const kioskDenyOld = await kioskDocGuard(session, oldDocumentId)
  if (kioskDenyOld) return kioskDenyOld
  if (!reason || reason.trim() === '' || reason.trim().length > 500) {
    return jsonNoStore({ error: '取代舊版要原因（≤500 字）' }, { status: 400 })
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return jsonNoStore({ error: 'version 必須係非負整數（optimistic lock）' }, { status: 400 })
  }

  const scope = await labdocScope(session, perms)
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  const [newDoc, oldDoc] = await Promise.all([
    prisma.labDocument.findUnique({ where: { id: params.id }, select: { id: true, kind: true, status: true, version: true, clinicId: true, statementMonth: true } }),
    prisma.labDocument.findUnique({ where: { id: oldDocumentId }, select: { id: true, kind: true, status: true, clinicId: true, statementMonth: true, uploadedBy: true } }),
  ])
  if (!newDoc || !oldDoc) {
    return jsonNoStore({ error: '單據唔存在' }, { status: 404 })
  }
  if (newDoc.kind !== 'STATEMENT' || oldDoc.kind !== 'STATEMENT') {
    return jsonNoStore({ error: '只有月結單可以取代舊版' }, { status: 400 })
  }
  if (newDoc.status === 'VOID' || newDoc.status === 'SUPERSEDED') {
    return jsonNoStore({ error: '新文件已作廢或已被取代' }, { status: 409 })
  }
  if (oldDoc.status === 'VOID' || oldDoc.status === 'SUPERSEDED') {
    return jsonNoStore({ error: '舊文件已作廢或已被取代' }, { status: 409 })
  }
  if (newDoc.version !== version) {
    return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null

  // 單 transaction：舊 SUPERSEDED＋新 version++（optimistic lock）＋帶過舊版已處理嘅差異
  let carried = 0
  let newSectionIds: string[] = []
  let oldSectionIds: string[] = []
  let unconfirmedSectionIds: string[] = []
  try {
    await prisma.$transaction(async (tx: any) => {
      const n = await tx.labDocument.updateMany({
        where: { id: newDoc.id, version },
        data: { version: { increment: 1 } },
      })
      if (n.count === 0) throw new SupersedeConflict()
      // ★ 2026-10-12：舊版喺「兩份加埋一齊對」組 → 組入面其他段之前嘅確認（對住舊版嘅行）打返未確認
      unconfirmedSectionIds = await unconfirmSections(tx, await otherGroupMembersOfDoc(tx, oldDoc.id))
      const o = await tx.labDocument.updateMany({
        where: { id: oldDoc.id, status: { notIn: ['VOID', 'SUPERSEDED'] } },
        data: { status: 'SUPERSEDED', supersededById: newDoc.id },
      })
      if (o.count === 0) throw new SupersedeConflict() // throw = rollback（唔好淨係改咗新單 version）

      // 2026-10-10 修：Lab 重發同一份月結單 → 舊版逐行處理（INVOICE_WINS／NOT_OURS／跟進完成…）帶過去新版，
      // 唔使重做；對應 key = 同段（診所＋醫生）＋ 單號＋金額＋描述＋數量。
      const [oldSecs, newSecs] = await Promise.all([
        tx.labStatementSection.findMany({ where: { documentId: oldDoc.id }, include: { lines: true } }),
        tx.labStatementSection.findMany({ where: { documentId: newDoc.id }, include: { lines: true } }),
      ])
      newSectionIds = newSecs.map((s: any) => s.id)
      oldSectionIds = oldSecs.map((s: any) => s.id)
      const key = (l: any) => [l.docNoRaw ?? '', Number(l.amount ?? 0).toFixed(2), l.description ?? '', l.qty == null ? '' : Number(l.qty)].join('|')
      for (const ns of newSecs) {
        const os = oldSecs.find((x: any) => x.clinicId && x.clinicId === ns.clinicId && x.providerId === ns.providerId)
        if (!os) continue
        // ★ 2026-10-12：組關係跟住新版（新版指返舊版指緊嗰段；指住舊版嘅段改指新版）
        if (os.combineWithSectionId && !ns.combineWithSectionId && os.combineWithSectionId !== ns.id) {
          await tx.labStatementSection.update({ where: { id: ns.id }, data: { combineWithSectionId: os.combineWithSectionId } })
        }
        await tx.labStatementSection.updateMany({ where: { combineWithSectionId: os.id, id: { not: ns.id } }, data: { combineWithSectionId: ns.id } })
        const pool = new Map<string, any[]>()
        for (const l of os.lines) {
          // 上月結轉副本唔帶（新版對數時會自己同步）
          if (!l.resolution || l.carriedFromLineId) continue
          const k = key(l)
          pool.set(k, [...(pool.get(k) ?? []), l])
        }
        for (const l of ns.lines) {
          if (l.resolution || l.carriedFromLineId) continue
          const hit = pool.get(key(l))?.shift()
          if (!hit) continue
          await tx.labStatementLine.update({
            where: { id: l.id },
            data: {
              resolution: hit.resolution,
              resolutionNote: hit.resolutionNote,
              resolvedBy: hit.resolvedBy,
              resolvedAt: hit.resolvedAt,
              followUpClosedAt: hit.followUpClosedAt,
              followUpClosedBy: hit.followUpClosedBy,
              ...(hit.resolution === 'MANUAL_PAIRED'
                ? { result: hit.result, matchBasis: hit.matchBasis, matchedDocumentId: hit.matchedDocumentId, matchedLineId: hit.matchedLineId }
                : {}),
            },
          })
          // ★ 2026-10-11：「計入下個月」帶去新版 → 下個月嘅結轉副本（包括已確認嗰啲）改指新版嗰行，
          //   咁取消新版標記時鎖先查得到（唔會變成兩個月都計）
          if (hit.resolution === 'NEXT_MONTH') {
            await tx.labStatementLine.updateMany({ where: { carriedFromLineId: hit.id }, data: { carriedFromLineId: l.id } })
          }
          carried++
        }
      }
    }, { timeout: 30_000 })
  } catch (e) {
    if (e instanceof SupersedeConflict) return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
    throw e
  }

  // 帶過嘅處理要反映喺分段總數／狀態 → 重跑配對（已有 resolution 嘅行保留）
  if (carried > 0) {
    for (const sid of newSectionIds) {
      await reconcileSection(prisma, { sectionId: sid, actorId: session.userId, source: 'manual', ipAddress: ip, userAgent: ua }).catch(() => undefined)
    }
  }

  // ★ 2026-10-11：舊版「計入下個月」嘅行唔再係來源（新版帶咗標記就由新版做來源）→ 下個月結轉即刻同步
  await afterCarryChange(prisma, { sectionIds: [...oldSectionIds, ...newSectionIds] }, session.userId)

  await labdocAudit({
    action: 'LAB_STATEMENT_SUPERSEDE',
    entity: 'LabDocument',
    entityId: newDoc.id,
    clinicId: oldDoc.clinicId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: reason.trim(),
    before: { oldDocumentId: oldDoc.id, oldStatus: oldDoc.status },
    after: { newDocumentId: newDoc.id, oldStatus: 'SUPERSEDED', supersededById: newDoc.id, statementMonth: oldDoc.statementMonth, ...(unconfirmedSectionIds.length ? { unconfirmedSectionIds } : {}) },
  })
  return NextResponse.json({ ok: true, oldDocumentId: oldDoc.id, oldStatus: 'SUPERSEDED', supersededById: newDoc.id, carriedResolutions: carried, unconfirmedSectionIds })
}

class SupersedeConflict extends Error {}
