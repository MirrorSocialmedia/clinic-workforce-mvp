import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/my/leave — My leave requests + balance
// All roles — returns the current employee's data
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  // Get leave requests
  const requests = await prisma.leaveRequest.findMany({
    where: { employeeId: employee.id },
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, color: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  // Get leave balances (current year)
  const currentYear = new Date().getFullYear()
  const balances = await prisma.leaveBalance.findMany({
    where: {
      employeeId: employee.id,
      year: currentYear,
    },
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, annualQuota: true, color: true } },
    },
  })

  // Get all active leave types
  const leaveTypes = await prisma.leaveType.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  })

  return NextResponse.json({
    leaveRequests: requests,
    leaveBalances: balances,
    leaveTypes,
  })
}
