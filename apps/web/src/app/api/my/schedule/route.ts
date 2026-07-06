export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/my/schedule — My upcoming schedule
// All roles — returns the current employee's shifts
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const where: any = { employeeId: employee.id }

  if (from) {
    where.startTime = { gte: new Date(from) }
  } else {
    where.startTime = { gte: new Date() }
  }

  if (to) {
    where.startTime = { ...where.startTime, lte: new Date(to) }
  }

  const shifts = await prisma.shift.findMany({
    where,
    include: {
      clinic: { select: { id: true, name: true, address: true } },
      template: { select: { id: true, name: true } },
    },
    orderBy: { startTime: 'asc' },
    take: 50,
  })

  return NextResponse.json({ shifts })
}
