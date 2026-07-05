import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { generateDailyHash, listDailyHashes, verifyDailyHash } from '@/lib/daily-hash'

// ============================================================
// POST /api/daily-hash — Generate daily hash for a clinic
// Roles: OWNER, MANAGER
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
      const { clinicId, date } = body

      if (!clinicId || !date) {
        return NextResponse.json({ error: 'clinicId and date are required' }, { status: 400 })
      }

      // Clinic access check
      if (scope !== 'all' && !session.clinics.includes(clinicId)) {
        return NextResponse.json({ error: 'No access to this clinic' }, { status: 403 })
      }

      const targetDate = new Date(date)
      targetDate.setHours(0, 0, 0, 0)

      const result = await generateDailyHash(clinicId, targetDate)

      if (!result) {
        return NextResponse.json(
          { error: 'No punch records found for this date' },
          { status: 404 }
        )
      }

      return NextResponse.json({
        success: true,
        clinicId,
        date: targetDate.toISOString(),
        hash: result.hash,
        recordCount: result.recordCount,
      })
    } catch (error) {
      console.error('Daily hash error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}

// ============================================================
// GET /api/daily-hash — List or get daily hashes
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const date = searchParams.get('date')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')
  const verify = searchParams.get('verify')

  if (clinicId && date) {
    const targetDate = new Date(date)
    targetDate.setHours(0, 0, 0, 0)

    if (verify === 'true') {
      const result = await verifyDailyHash(clinicId, targetDate)
      return NextResponse.json({ clinicId, date: targetDate.toISOString(), ...result })
    }

    const hash = await prisma.dailyHash.findUnique({
      where: { clinicId_date: { clinicId, date: targetDate } },
      include: { clinic: { select: { id: true, name: true } } },
    })

    return NextResponse.json({ hash })
  }

  let effectiveClinicId = clinicId

  if (!effectiveClinicId) {
    if (scope === 'my-clinics' && session.clinics.length > 0) {
      effectiveClinicId = session.clinics[0]
    }
  }

  if (!effectiveClinicId) {
    return NextResponse.json({ error: 'clinicId is required' }, { status: 400 })
  }

  const hashes = await listDailyHashes(
    effectiveClinicId,
    startDate ? new Date(startDate) : undefined,
    endDate ? new Date(endDate) : undefined
  )

  return NextResponse.json({ hashes })
}
