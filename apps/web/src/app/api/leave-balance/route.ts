export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/leave-balance — Get leave balance
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// Employee sees own; managers see all (optionally filtered by employeeId)
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const year = searchParams.get('year')

  let targetEmployeeId: string | undefined

  // Employees only see their own balance
  if (scope === 'self') {
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    if (!emp) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })
    targetEmployeeId = emp.id
  } else if (employeeId) {
    targetEmployeeId = employeeId
  }

  const where: any = targetEmployeeId ? { employeeId: targetEmployeeId } : {}
  if (year) where.year = parseInt(year)

  const balances = await prisma.leaveBalance.findMany({
    where,
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, annualQuota: true, color: true } },
      employee: {
        include: { user: { select: { id: true, name: true } } },
      },
    },
    orderBy: [{ year: 'desc' }, { leaveType: { name: 'asc' } }],
  })

  return NextResponse.json({ leaveBalances: balances })
}
