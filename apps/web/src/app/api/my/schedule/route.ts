export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/my/schedule — My upcoming schedule
// All roles — returns the current employee's shifts
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
    // Default: next 7 days
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
