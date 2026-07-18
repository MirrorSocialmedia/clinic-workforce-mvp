export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const employee = await prisma.employee.findUnique({ where: { userId: auth.session.userId } })
  if (!employee) return NextResponse.json({ status: 'NO_EMPLOYEE' })

  const active = await prisma.faceTemplate.findFirst({ where: { employeeId: employee.id, active: true } })
  if (active) return NextResponse.json({ status: 'ACTIVE' })

  const pending = await prisma.faceTemplate.findFirst({
    where: { employeeId: employee.id, active: false, approvedAt: null },
    orderBy: { enrolledAt: 'desc' },
  })
  return NextResponse.json({ status: pending ? 'PENDING' : 'NOT_ENROLLED' })
}
