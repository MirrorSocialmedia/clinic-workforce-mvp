import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/leave-balance — Get leave balance
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// Employee sees own; managers see all (optionally filtered by employeeId)
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const year = searchParams.get('year')

  let targetEmployeeId: string | undefined

  // Employees only see their own balance
  if (session.role === 'EMPLOYEE') {
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
        include: {
          user: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ year: 'desc' }, { leaveType: { name: 'asc' } }],
  })

  return NextResponse.json({ leaveBalances: balances })
}
