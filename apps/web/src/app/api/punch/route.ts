import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { validateAndMarkTokenUsed } from '@/lib/qr-token'

// ============================================================
// POST /api/punch — Clock in/out via QR token
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()
      const { token: qrToken, punchType, deviceInfo } = body

      // Validate punch type
      if (!['CLOCK_IN', 'CLOCK_OUT'].includes(punchType)) {
        return NextResponse.json(
          { error: 'punchType must be CLOCK_IN or CLOCK_OUT' },
          { status: 400 }
        )
      }

      if (!qrToken) {
        return NextResponse.json(
          { error: 'token is required' },
          { status: 400 }
        )
      }

      // Get the employee for this user
      const employee = await prisma.employee.findUnique({
        where: { userId: session.userId },
        include: {
          clinics: { select: { clinicId: true } },
        },
      })

      if (!employee) {
        return NextResponse.json(
          { error: 'Employee profile not found' },
          { status: 400 }
        )
      }

      // Atomic: validate + mark token used in one operation
      const validation = await validateAndMarkTokenUsed(qrToken, employee.id)

      if (!validation || !validation.valid) {
        return NextResponse.json(
          { error: `QR token invalid: ${validation?.reason || 'unknown'}` },
          { status: 400 }
        )
      }

      const clinicId = validation.clinicId

      if (!clinicId) {
        return NextResponse.json({ error: 'Token missing clinicId' }, { status: 400 })
      }

      // Verify employee belongs to this clinic
      const empClinicIds = employee.clinics.map((ec: any) => ec.clinicId)
      if (!empClinicIds.includes(clinicId)) {
        return NextResponse.json(
          { error: 'You are not assigned to this clinic' },
          { status: 403 }
        )
      }

      // Transaction: punch record + audit log atomically
      const result = await prisma.$transaction(async (tx) => {
        const record = await tx.punchRecord.create({
          data: {
            employeeId: employee.id,
            clinicId,
            punchTime: new Date(),
            punchType: punchType as any,
            source: (validation.source || 'QR_DYNAMIC') as any,
            tokenValid: true,
            deviceInfo: deviceInfo || null,
          },
        })

        // Audit log in same transaction
        await tx.auditLog.create({
          data: {
            actorId: session.userId,
            action: 'PUNCH',
            entity: 'PunchRecord',
            entityId: record.id,
            notes: `${punchType} at clinic ${clinicId}`,
            ipAddress: auditCtx.ip || null,
            userAgent: auditCtx.ua || null,
          },
        })

        return record
      })

      return NextResponse.json({
        success: true,
        recordId: result.id,
        punchTime: result.punchTime.toISOString(),
        punchType: result.punchType,
      })
    } catch (error: any) {
      console.error('Punch error:', error)
      // Transaction rollback already happened
      if (error.code === 'P2025') {
        // Record not unique — token already used
        return NextResponse.json({ error: 'Token invalid or already used' }, { status: 400 })
      }
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
