export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { createNotification } from '@/lib/notification'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { revokeStaleEarlyOt } from '@/lib/early-in-ot'
import { toHKDateStr, hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { lockEmployee, HttpError, toHttpResponse } from '@/lib/emp-lock'

// PUT /api/punch-corrections/[id] — Approve/reject a correction
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const body = await req.json()
    const { action, notes } = body

    if (!['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json({ error: 'action must be APPROVE or REJECT' }, { status: 400 })
    }

    const id = params.id
    const correction = await prisma.punchCorrection.findUnique({
      where: { id },
      include: { employee: { select: { userId: true } } },
    })
    if (!correction) return NextResponse.json({ error: 'Correction not found' }, { status: 404 })
    if (correction.status !== 'PENDING') {
      return NextResponse.json({ error: `Correction already ${correction.status}` }, { status: 400 })
    }

    // Manager can only approve corrections for their clinics
    if (scope === 'my-clinics' && !(session.clinics ?? []).includes(correction.clinicId)) {
      return NextResponse.json({ error: 'You do not have access to this clinic' }, { status: 403 })
    }

    const status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED'

    // Transaction: correction update (audit auto-handled by Prisma extension)
    let updated
    try {
      updated = await prisma.$transaction(async (tx) => {
        await lockEmployee(tx, correction.employeeId)
        // ★ Stage 4A 嘅 assertMonthsUnlockedTx 會插喺呢度（見 Stage 4）
        const result = await tx.punchCorrection.update({
          where: { id, status: 'PENDING' },
          data: { status: status as any, approvedBy: session.userId },
        })

        // ★ Stage 2.3：通知入 tx（同狀態同生死，outbox 語義）
        const notify = () => createNotification({
          employeeId: correction.employeeId,
          type: action === 'APPROVE' ? 'CORRECTION_APPROVED' : 'CORRECTION_REJECTED',
          content: action === 'APPROVE'
            ? `Your punch correction request has been approved.`
            : `Your punch correction request has been rejected.${notes ? ` Reason: ${notes}` : ''}`,
          relatedEntity: 'PunchCorrection',
          relatedId: correction.id,
        }, tx)

        if (status !== 'APPROVED') {
          await notify()
          return result
        }

        // ★ Stage 2.4：自批 audit + 失效 + OT 撤回入 tx（失敗 = rollback）
        // ★ 自批記錄：批核自己提出嘅 PENDING 申請
        if (correction.employee?.userId === session.userId) {
          await tx.auditLog.create({
            data: {
              actorId: session.userId,
              action: 'CORRECTION_SELF_APPROVE',
              entity: 'PunchCorrection',
              entityId: correction.id,
              targetEmployeeId: correction.employeeId,
              clinicId: correction.clinicId,
              afterJson: JSON.stringify({ correctedTime: correction.correctedTime, punchType: correction.punchType }),
              notes: '批核自己提出的補登申請',
              ipAddress: req.headers.get('x-forwarded-for') || null,
              userAgent: req.headers.get('user-agent') || null,
            },
          })
        }
        // ★ 審批通過會新增 PunchRecord，快取必須清（同 OT 撤回一齊入 tx）
        await invalidateTimeBankFrom(correction.employeeId, correction.correctedTime, tx)
        // ★ 2026-08-08: Revoke stale early-in OT if punches changed
        await revokeStaleEarlyOt(correction.employeeId, toHKDateStr(correction.correctedTime), session.userId, 'CORRECTION_APPROVE', tx)

        if (correction.punchRecordId) {
          // ★ RC-07：原卡已作廢 → 呢張修正冇嘢可以 overlay，唔准「假成功」
          const voided = await tx.punchVoid.findUnique({ where: { punchRecordId: correction.punchRecordId } })
          if (voided) throw new HttpError(409, '原打卡已被作廢，呢張修正冇效，請員工重新提交補登')
          await notify()
          return result
        }
        // ★ RC-05：冇 link → 先搵同日同類 active 卡（申請後員工可能已經真打咗），有就 link，冇先建
        const day = toHKDateStr(correction.correctedTime)
        const existing = await tx.punchRecord.findFirst({
          where: { employeeId: correction.employeeId, clinicId: correction.clinicId, punchType: correction.punchType,
                   punchTime: { gte: hkDateStart(day), lte: hkDateEnd(day) }, void: { is: null } },
          orderBy: [{ punchTime: 'asc' }, { id: 'asc' }],
          select: { id: true },
        })
        const targetId = existing?.id ?? (await tx.punchRecord.create({
          data: {
            employeeId: correction.employeeId,
            clinicId: correction.clinicId,
            punchTime: correction.correctedTime,
            punchType: correction.punchType,
            source: 'MANUAL_CORRECTION' as any,
            tokenValid: null,
            notes: notes || `Corrected via punch correction #${correction.id}: ${correction.reason || 'N/A'}`,
          },
        })).id
        // ★ cwm-antitamper P1-4：一定要回寫，否則 punch-query 當 orphan 再砌一張 synthetic
        await notify()
        return tx.punchCorrection.update({ where: { id }, data: { punchRecordId: targetId } })
      })
    } catch (e: any) {
      { const r = toHttpResponse(e); if (r) return r }
      if (e?.code === 'P2025') {
        return NextResponse.json({ error: '呢張申請已經有人處理咗' }, { status: 409 })
      }
      throw e
    }

    return NextResponse.json({ success: true, correction: updated })
  })
}
