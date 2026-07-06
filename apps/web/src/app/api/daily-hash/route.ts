export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'
import { generateDailyHash, listDailyHashes, verifyDailyHash } from '@/lib/daily-hash'

// ============================================================
// POST /api/daily-hash — Generate daily hash for a clinic
// Roles: OWNER, MANAGER
// ============================================================
export async function POST(req: NextRequest) {
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
    const { clinicId, date } = body

    if (!clinicId || !date) {
      return NextResponse.json(
        { error: 'clinicId and date are required' },
        { status: 400 }
      )
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
}

// ============================================================
// GET /api/daily-hash — List or get daily hashes
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const date = searchParams.get('date')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')
  const verify = searchParams.get('verify')

  // Single date lookup
  if (clinicId && date) {
    const targetDate = new Date(date)
    targetDate.setHours(0, 0, 0, 0)

    if (verify === 'true') {
      const result = await verifyDailyHash(clinicId, targetDate)
      return NextResponse.json({
        clinicId,
        date: targetDate.toISOString(),
        ...result,
      })
    }

    // Just get the hash
    const hash = await prisma.dailyHash.findUnique({
      where: {
        clinicId_date: { clinicId, date: targetDate },
      },
      include: {
        clinic: { select: { id: true, name: true } },
      },
    })

    return NextResponse.json({ hash })
  }

  // List hashes
  let effectiveClinicId = clinicId

  if (!effectiveClinicId) {
    // Default to first clinic user has access to
    if (session.role === 'MANAGER' && session.clinics.length > 0) {
      effectiveClinicId = session.clinics[0]
    }
  }

  if (!effectiveClinicId) {
    return NextResponse.json(
      { error: 'clinicId is required' },
      { status: 400 }
    )
  }

  const hashes = await listDailyHashes(
    effectiveClinicId,
    startDate ? new Date(startDate) : undefined,
    endDate ? new Date(endDate) : undefined
  )

  return NextResponse.json({ hashes })
}
