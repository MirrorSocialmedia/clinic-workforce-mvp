import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/employees/:id/pay-history — pay rule history
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const employee = await prisma.employee.findUnique({ where: { id: params.id } })
  if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  const payRules = await prisma.payRule.findMany({
    where: { employeeId: params.id },
    orderBy: { effectiveFrom: 'desc' },
  })

  return NextResponse.json({ payRules })
}
