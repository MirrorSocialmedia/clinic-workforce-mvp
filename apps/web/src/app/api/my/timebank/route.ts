export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', '/api/my/timebank')
  if (isAuthError(auth)) return auth.error

  const employee = await prisma.employee.findUnique({
    where: { userId: auth.session.userId },
    select: { id: true },
  })
  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const tb = await calculateTimeBank(employee.id, new Date(), {}, prisma)
  return NextResponse.json(tb)
}
