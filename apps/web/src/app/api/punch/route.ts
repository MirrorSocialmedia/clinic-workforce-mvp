export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { validateAndMarkTokenUsed } from '@/lib/qr-token'
import { todayHK, hkDateStart } from '@/lib/hk-date'
import { distanceMeters } from '@/lib/geo'

// ============================================================
// POST /api/punch — Clock in/out via QR token or manual lunch punch
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================

/**
 * Get start of today in Asia/Hong_Kong timezone (UTC+8).
 * Returns a Date object at midnight HK time, converted to UTC for DB comparison.
 */
function getTodayStartHK(): Date {
  return hkDateStart(todayHK())
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
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
      const { token: qrToken, deviceInfo, lat, lng, geoFlag, geoAcc } = body

      // Accept optional explicit punchType (CLOCK_IN/CLOCK_OUT/LUNCH_START/LUNCH_END)
      const explicitPunchType = body.punchType
      const VALID_TYPES = ['CLOCK_IN', 'CLOCK_OUT', 'LUNCH_START', 'LUNCH_END']
      const hasExplicitType = VALID_TYPES.includes(explicitPunchType)

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

      let clinicId: string | null = null
      let source: string = 'QR_DYNAMIC'
      let tokenValid: boolean | null = true

      // ★ Token + clinic resolution: token-first, explicit-fallback
      if (qrToken) {
        // Atomic: validate + mark token used in one operation
        const validation = await validateAndMarkTokenUsed(qrToken, employee.id)

        if (!validation || !validation.valid) {
          return NextResponse.json(
            { error: `QR token invalid: ${validation?.reason || 'unknown'}` },
            { status: 400 }
          )
        }

        clinicId = validation.clinicId ?? null
        if (!clinicId) {
          return NextResponse.json(
            { error: 'Clinic ID missing from token validation' },
            { status: 400 }
          )
        }

        // Verify employee belongs to this clinic
        const empClinicIds = employee.clinics.map((ec: any) => ec.clinicId)
        if (!empClinicIds.includes(clinicId)) {
          return NextResponse.json(
            { error: 'You are not assigned to this clinic' },
            { status: 403 }
          )
        }

        source = validation.source || 'QR_DYNAMIC'
        // ★ Explicit type + valid token = normal punch, NOT MANUAL_CORRECTION
      } else if (hasExplicitType) {
        // Explicit type without QR token (e.g., legacy lunch punch): use employee's first clinic
        clinicId = employee.clinics[0]?.clinicId || null
        if (!clinicId) {
          return NextResponse.json({ error: 'No clinic assigned' }, { status: 400 })
        }
        source = 'MANUAL'
        tokenValid = null
      } else {
        return NextResponse.json({ error: 'token is required' }, { status: 400 })
      }

      // Determine punch type
      const todayStart = getTodayStartHK()
      const todayPunches = await prisma.punchRecord.findMany({
        where: {
          employeeId: employee.id,
          clinicId,
          punchTime: { gte: todayStart },
          void: { is: null }, // 已作廢的不算存在
        },
        orderBy: { punchTime: 'desc' },
        take: 20,
      })

      let punchType: string
      if (hasExplicitType) {
        punchType = explicitPunchType
        // Per-type daily limit: max 1 of each type per day
        if (todayPunches.some(p => p.punchType === punchType)) {
          const label = punchType === 'CLOCK_IN' ? '上班' : punchType === 'CLOCK_OUT' ? '下班' : punchType === 'LUNCH_START' ? '午休開始' : '午休結束'
          return NextResponse.json(
            { error: `今天已打${label}卡` },
            { status: 400 }
          )
        }
      } else {
        // Fallback: old frontend compatibility — auto-detect CLOCK_IN/CLOCK_OUT
        const hasClockInToday = todayPunches.some(p => p.punchType === 'CLOCK_IN')
        const hasClockOutToday = todayPunches.some(p => p.punchType === 'CLOCK_OUT')

        if (!hasClockInToday) {
          punchType = 'CLOCK_IN'
        } else if (!hasClockOutToday) {
          punchType = 'CLOCK_OUT'
        } else {
          return NextResponse.json(
            { error: '今天已完成上下班打卡，如需修改請用補打卡' },
            { status: 400 }
          )
        }
      }

      // ★ GPS location verification (shadow mode — observation only, never blocks)
      let punchLat = null,
        punchLng = null,
        distanceM = null,
        locationFlag: string | null = geoFlag || null,
        geoAccuracy: number | null = geoAcc != null ? Math.round(geoAcc) : null

      if (!geoFlag && lat != null && lng != null) {
        punchLat = lat
        punchLng = lng
        const clinic = await prisma.clinic.findUnique({
          where: { id: clinicId },
          select: { latitude: true, longitude: true, geoRadius: true },
        })
        if (clinic?.latitude != null && clinic?.longitude != null) {
          distanceM = distanceMeters(lat, lng, clinic.latitude, clinic.longitude)
          const radius = clinic.geoRadius ?? Number(process.env.GEO_DEFAULT_RADIUS || 200)
          if (distanceM > radius) locationFlag = 'OUT_OF_RANGE'
        }
      }

      // Transaction: punch record (audit auto-handled by Prisma extension)
      const result = await prisma.$transaction(async (tx) => {
        const record = await tx.punchRecord.create({
          data: {
            employeeId: employee.id,
            clinicId,
            punchTime: new Date(),
            punchType: punchType as any,
            source: source as any,
            tokenValid,
            deviceInfo: deviceInfo || null,
            punchLat,
            punchLng,
            distanceM,
            locationFlag,
            geoAccuracy,
          },
        })

        return record
      })

      return NextResponse.json({
        success: true,
        recordId: result.id,
        punchTime: result.punchTime.toISOString(),
        punchType,
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
