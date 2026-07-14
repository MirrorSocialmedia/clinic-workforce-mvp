export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { todayHK, hkDateStart } from '@/lib/hk-date'

/** Get start/end of today in HK (UTC+8) */
function hkTodayBounds() {
  const start = hkDateStart(todayHK())
  const end = new Date(start)
  end.setDate(end.getDate() + 1)  // tz-ok: client-equivalent week range
  return { start, end }
}

// GET /api/dashboard — dashboard data based on role
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  let clinics: any[] = []

  if (scope === 'all') {
    clinics = await prisma.clinic.findMany({
      include: {
        _count: {
          select: {
            users: true,
            employees: true,
            shifts: true,
            punches: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })
  } else {
    clinics = await prisma.clinic.findMany({
      where: { id: { in: session.clinics } },
      include: {
        _count: {
          select: {
            users: true,
            employees: true,
            shifts: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })
  }

  // ── Today's daily stats per clinic ──
  const { start: todayStart, end: todayEnd } = hkTodayBounds()

  const todayStats = await Promise.all(clinics.map(async (clinic) => {
    // 1. Scheduled shifts today (non-cancelled)
    const scheduled = await prisma.shift.count({
      where: {
        clinicId: clinic.id,
        date: { gte: todayStart, lt: todayEnd },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
      },
    })

    // 2. Employee IDs who have a scheduled shift today
    const scheduledEmployees = await prisma.shift.findMany({
      where: {
        clinicId: clinic.id,
        date: { gte: todayStart, lt: todayEnd },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
      },
      select: { employeeId: true, startTime: true },
    })

    const employeeIds = scheduledEmployees.map((s) => s.employeeId)

    // 3. CLOCK_IN records today at this clinic for scheduled employees
    const punchRecords =
      employeeIds.length > 0
        ? await prisma.punchRecord.findMany({
            where: {
              clinicId: clinic.id,
              employeeId: { in: employeeIds },
              punchType: 'CLOCK_IN',
              punchTime: { gte: todayStart, lt: todayEnd },
              void: { is: null }, // 已作廢的不算
            },
            select: { employeeId: true, punchTime: true },
          })
        : []

    const clockedInSet = new Set(punchRecords.map((p) => p.employeeId))
    const clockedIn = clockedInSet.size

    // 4. Late count: CLOCK_IN punchTime > shift startTime
    const shiftStartTimeMap = new Map(scheduledEmployees.map((s) => [s.employeeId, s.startTime.getTime()]))
    let late = 0
    for (const punch of punchRecords) {
      const shiftStartTs = shiftStartTimeMap.get(punch.employeeId)
      if (shiftStartTs != null && punch.punchTime.getTime() > shiftStartTs) {
        late++
      }
    }

    return {
      clinicId: clinic.id,
      clinicName: clinic.name,
      scheduled,
      clockedIn,
      late,
      notArrived: scheduled - clockedIn,
    }
  }))

  // Attach todayStats to each clinic object
  const clinicsWithStats = clinics.map((clinic) => ({
    ...clinic,
    todayStats: todayStats.find((s) => s.clinicId === clinic.id) ?? null,
  }))

  // Get recent audit logs for non-EMPLOYEE
  let recentAuditLogs: any[] = []
  if (scope !== 'self') {
    const where: any = {}
    if (scope === 'my-clinics' && session.clinics.length > 0) {
      where.clinicId = { in: session.clinics }
    }
    recentAuditLogs = await prisma.auditLog.findMany({
      where,
      include: { actor: { select: { name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
  }

  // Count distinct employees across all clinics (not EmployeeClinic bindings)
  const allEmployeeClinics = await prisma.employeeClinic.findMany({
    where: {
      clinicId: { in: clinics.map(c => c.id) },
    },
    select: { employeeId: true },
  })
  const distinctEmployeeCount = new Set(allEmployeeClinics.map(ec => ec.employeeId)).size

  return NextResponse.json({
    role: session.role,
    clinics: clinicsWithStats,
    recentAuditLogs,
    distinctEmployeeCount,
  })
}
