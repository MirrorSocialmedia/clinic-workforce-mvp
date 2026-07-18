export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER')
    return NextResponse.json({ error: '僅老闆可查看' }, { status: 403 })

  const resolvedParams = await params
  const empId = resolvedParams.id
  const lastDay = new URL(req.url).searchParams.get('lastDay')
  if (!lastDay)
    return NextResponse.json({ error: 'lastDay 必填' }, { status: 400 })

  const cutoff = new Date(`${lastDay}T16:00:00Z`) // HK midnight = UTC 16:00

  const [futureShifts, futureLeaves] = await Promise.all([
    prisma.shift.count({
      where: {
        employeeId: empId,
        date: { gt: cutoff },
        status: { not: 'CANCELLED' },
      },
    }),
    prisma.leaveRequest.count({
      where: {
        employeeId: empId,
        startDate: { gt: cutoff },
        status: 'APPROVED',
      },
    }),
  ])

  return NextResponse.json({ futureShifts, futureApprovedLeaves: futureLeaves })
}
