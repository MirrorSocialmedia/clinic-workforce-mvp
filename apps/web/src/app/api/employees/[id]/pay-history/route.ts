import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/employees/:id/pay-history — pay rule history
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const allowedRoles = ['OWNER', 'MANAGER', 'ACCOUNTANT']
  if (!allowedRoles.includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Verify employee exists
  const employee = await prisma.employee.findUnique({ where: { id: params.id } })
  if (!employee) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 })
  }

  const payRules = await prisma.payRule.findMany({
    where: { employeeId: params.id },
    orderBy: { effectiveFrom: 'desc' },
  })

  return NextResponse.json({ payRules })
}
