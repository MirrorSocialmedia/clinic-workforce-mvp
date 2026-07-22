export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { createNotification } from '@/lib/notification'

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
    const correction = await prisma.punchCorrection.findUnique({ where: { id } })
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
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.punchCorrection.update({
        where: { id },
        data: { status: status as any, approvedBy: session.userId },
      })

      // If approved and no original punch record exists, create one
      if (status === 'APPROVED' && !correction.punchRecordId) {
        await tx.punchRecord.create({
          data: {
            employeeId: correction.employeeId,
            clinicId: correction.clinicId,
            punchTime: correction.correctedTime,
            punchType: correction.punchType,
            source: 'MANUAL_CORRECTION' as any,
            tokenValid: null,
            notes: notes || `Corrected via punch correction #${correction.id}: ${correction.reason || 'N/A'}`,
          },
        })
      }

      return result
    })

    // Notification outside transaction (non-critical side effect)

    await createNotification({
      employeeId: correction.employeeId,
      type: 'CORRECTION_APPROVED',
      content: action === 'APPROVE'
        ? `Your punch correction request has been approved.`
        : `Your punch correction request has been rejected.${notes ? ` Reason: ${notes}` : ''}`,
      relatedEntity: 'PunchCorrection',
      relatedId: correction.id,
    })

    return NextResponse.json({ success: true, correction: updated })
  })
}
