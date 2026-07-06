export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma, createAuditLog } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'
import { validateQRToken, markTokenUsed } from '@/lib/qr-token'

// ============================================================
// POST /api/punch — Clock in/out via QR token
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function POST(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

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

    // Validate QR token
    const validation = await validateQRToken(qrToken)

    if (!validation || !validation.valid) {
      return NextResponse.json(
        { error: `QR token invalid: ${validation?.reason || 'unknown'}` },
        { status: 400 }
      )
    }

    const tokenRecord = validation.tokenRecord
    const clinicId = tokenRecord.clinicId

    // Verify employee belongs to this clinic
    const empClinicIds = employee.clinics.map((ec: any) => ec.clinicId)
    if (!empClinicIds.includes(clinicId)) {
      return NextResponse.json(
        { error: 'You are not assigned to this clinic' },
        { status: 403 }
      )
    }

    // Create punch record (append-only)
    const record = await prisma.punchRecord.create({
      data: {
        employeeId: employee.id,
        clinicId,
        punchTime: new Date(),
        punchType: punchType as any,
        source: tokenRecord ? 'QR_DYNAMIC' : 'QR_STATIC',
        tokenValid: true,
        deviceInfo: deviceInfo || null,
      },
    })

    // Mark token as used
    await markTokenUsed(qrToken, employee.id)

    // Audit log
    await createAuditLog({
      action: 'PUNCH',
      entity: 'PunchRecord',
      entityId: record.id,
      notes: `${punchType} at clinic ${clinicId}`,
    })

    return NextResponse.json({
      success: true,
      recordId: record.id,
      punchTime: record.punchTime.toISOString(),
      punchType: record.punchType,
    })
  } catch (error) {
    console.error('Punch error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
