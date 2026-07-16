export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr, getMonthRange } from '@/lib/hk-date'

// ============================================================
// GET /api/my/summary — Monthly summary (hours/OT/leave)
// All roles — returns the current employee's summary
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { searchParams } = new URL(req.url)
  const month = searchParams.get('month')

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  let targetMonth: string
  if (month) {
    targetMonth = month
  } else {
    const now = new Date()
    targetMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  }

  const { start: monthStart, end: monthEnd } = getMonthRange(new Date(`${targetMonth}-01T00:00:00+08:00`))

  const punches = await prisma.punchRecord.findMany({
    where: { employeeId: employee.id, punchTime: { gte: monthStart, lt: monthEnd }, void: { is: null } },
  })

  const clockIns = punches.filter(p => p.punchType === 'CLOCK_IN')
  const clockOuts = punches.filter(p => p.punchType === 'CLOCK_OUT')

  const shifts = await prisma.shift.findMany({
    where: { employeeId: employee.id, startTime: { gte: monthStart, lt: monthEnd } },
  })

  // Late attendance tracking: compare CLOCK_IN vs shift startTime
  let lateCount = 0
  let lateMinutes = 0

  for (const clockIn of clockIns) {
    // Find the matching shift on the same day (same clinic, same HK date)
    const clockInHKDate = toHKDateStr(clockIn.punchTime)
    const shift = shifts.find(s => toHKDateStr(s.startTime) === clockInHKDate)

    if (shift && clockIn.punchTime > shift.startTime) {
      lateCount++
      const diffMs = clockIn.punchTime.getTime() - shift.startTime.getTime()
      lateMinutes += Math.round(diffMs / 60000)
    }
  }

  const leaveRequests = await prisma.leaveRequest.findMany({
    where: {
      employeeId: employee.id,
      status: 'APPROVED',
      startDate: { gte: monthStart, lt: monthEnd },
    },
    include: { leaveType: { select: { name: true, isPaid: true } } },
  })

  const totalLeaveDays = leaveRequests.reduce((sum, r) => sum + r.days, 0)

  const corrections = await prisma.punchCorrection.count({
    where: { employeeId: employee.id, status: 'APPROVED' },
  })

  return NextResponse.json({
    month: targetMonth,
    summary: {
      punchCount: punches.length,
      clockInCount: clockIns.length,
      clockOutCount: clockOuts.length,
      shiftCount: shifts.length,
      leaveDays: totalLeaveDays,
      lateCount,
      lateMinutes,
      leaveRequests: leaveRequests.map(r => ({
        type: r.leaveType.name,
        days: r.days,
        isPaid: r.leaveType.isPaid,
        startDate: toHKDateStr(r.startDate),
        endDate: toHKDateStr(r.endDate),
      })),
      correctionsCount: corrections,
    },
  })
}
