import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/my/summary — Monthly summary (hours/OT/leave)
// All roles — returns the current employee's summary
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const month = searchParams.get('month') // YYYY-MM format

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

  // Count punch records (clock-in pairs = worked days)
  const punches = await prisma.punchRecord.findMany({
    where: {
      employeeId: employee.id,
      punchTime: { gte: monthStart, lt: monthEnd },
    },
  })

  // Calculate worked days from clock-in/clock-out pairs
  const clockIns = punches.filter(p => p.punchType === 'CLOCK_IN')
  const clockOuts = punches.filter(p => p.punchType === 'CLOCK_OUT')

  // Get shifts
  const shifts = await prisma.shift.findMany({
    where: {
      employeeId: employee.id,
      startTime: { gte: monthStart, lt: monthEnd },
    },
  })

  // Get approved leave
  const leaveRequests = await prisma.leaveRequest.findMany({
    where: {
      employeeId: employee.id,
      status: 'APPROVED',
      startDate: { gte: monthStart, lt: monthEnd },
    },
    include: {
      leaveType: { select: { name: true, isPaid: true } },
    },
  })

  // Total leave days
  const totalLeaveDays = leaveRequests.reduce((sum, r) => sum + r.days, 0)

  // Corrections count
  const corrections = await prisma.punchCorrection.count({
    where: {
      employeeId: employee.id,
      status: 'APPROVED',
    },
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
        startDate: r.startDate.toISOString().split('T')[0],
        endDate: r.endDate.toISOString().split('T')[0],
      })),
      correctionsCount: corrections,
    },
  })
}
