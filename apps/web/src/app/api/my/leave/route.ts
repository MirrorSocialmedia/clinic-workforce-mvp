export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/my/leave — My leave requests + balance
// All roles — returns the current employee's data
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const requests = await prisma.leaveRequest.findMany({
    where: { employeeId: employee.id },
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, color: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  const currentYear = new Date().getFullYear()  // tz-ok: year-based DB key
  const balances = await prisma.leaveBalance.findMany({
    where: { employeeId: employee.id, year: currentYear },
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, annualQuota: true, color: true } },
    },
  })

  const leaveTypes = await prisma.leaveType.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  })

  return NextResponse.json({ leaveRequests: requests, leaveBalances: balances, leaveTypes })
}
