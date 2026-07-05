import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma, createAuditLog } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// ============================================================
// PUT /api/punch-corrections/[id] — Approve/reject a correction
// Roles: OWNER, MANAGER
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  try {
    const body = await req.json()
    const { action, notes } = body

    if (!['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json(
        { error: 'action must be APPROVE or REJECT' },
        { status: 400 }
      )
    }

    const id = params.id

    const correction = await prisma.punchCorrection.findUnique({
      where: { id },
    })

    if (!correction) {
      return NextResponse.json({ error: 'Correction not found' }, { status: 404 })
    }

    if (correction.status !== 'PENDING') {
      return NextResponse.json(
        { error: `Correction already ${correction.status}` },
        { status: 400 }
      )
    }

    // MANAGER can only approve corrections for their clinics
    if (session.role === 'MANAGER' && session.clinics.length > 0) {
      if (!session.clinics.includes(correction.clinicId)) {
        return NextResponse.json(
          { error: 'You do not have access to this clinic' },
          { status: 403 }
        )
      }
    }

    const status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED'

    const updated = await prisma.punchCorrection.update({
      where: { id },
      data: {
        status: status as any,
        approvedBy: session.userId,
      },
    })

    // If approved and no original punch record exists, create one
    if (status === 'APPROVED' && !correction.punchRecordId) {
      await prisma.punchRecord.create({
        data: {
          employeeId: correction.employeeId,
          clinicId: correction.clinicId,
          punchTime: correction.correctedTime,
          punchType: correction.punchType,
          source: 'MANUAL_CORRECTION',
          tokenValid: null,
          notes: notes || `Corrected via punch correction #${correction.id}: ${correction.reason || 'N/A'}`,
        },
      })
    }

    // Audit log
    await createAuditLog({
      action: 'CORRECTION_' + action,
      entity: 'PunchCorrection',
      entityId: correction.id,
      notes: `${action} punch correction #${id}${notes ? `: ${notes}` : ''}`,
    })

    return NextResponse.json({ success: true, correction: updated })
  } catch (error) {
    console.error('Punch correction approve/reject error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
