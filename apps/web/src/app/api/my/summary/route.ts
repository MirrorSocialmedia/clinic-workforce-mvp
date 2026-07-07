export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr } from '@/lib/hk-date'

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
    targetMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }

  const monthStart = new Date(`${targetMonth}-01T00:00:00`)
  const monthEnd = new Date(monthStart)
  monthEnd.setMonth(monthEnd.getMonth() + 1)

  const punches = await prisma.punchRecord.findMany({
    where: { employeeId: employee.id, punchTime: { gte: monthStart, lt: monthEnd } },
  })

  const clockIns = punches.filter(p => p.punchType === 'CLOCK_IN')
  const clockOuts = punches.filter(p => p.punchType === 'CLOCK_OUT')

  const shifts = await prisma.shift.findMany({
    where: { employeeId: employee.id, startTime: { gte: monthStart, lt: monthEnd } },
  })

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
