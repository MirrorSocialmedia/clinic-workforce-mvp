import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/punch/my-records — Current employee's punch records
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // For employees, get their employeeId
  let employeeId: string | undefined

  if (session.role === 'EMPLOYEE') {
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    if (!emp) {
      return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })
    }
    employeeId = emp.id
  } else if (session.role !== 'OWNER') {
    // For MANAGER/ACCOUNTANT, optionally filter by own records or show all
    employeeId = undefined
  }

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')

  const where: any = {}

  if (employeeId) where.employeeId = employeeId
  if (clinicId) where.clinicId = clinicId

  if (startDate || endDate) {
    where.punchTime = {}
    if (startDate) where.punchTime.gte = new Date(startDate)
    if (endDate) where.punchTime.lte = new Date(endDate)
  }

  const records = await prisma.punchRecord.findMany({
    where,
    include: {
      clinic: { select: { id: true, name: true } },
      corrections: {
        where: { status: 'APPROVED' },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { punchTime: 'desc' },
    take: 100,
  })

  return NextResponse.json({ records })
}
