import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/punches — List punch records with filters
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const employeeId = searchParams.get('employeeId')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')
  const punchType = searchParams.get('punchType')
  const page = parseInt(searchParams.get('page') || '1')
  const pageSize = parseInt(searchParams.get('pageSize') || '50')
  const skip = (page - 1) * pageSize

  const where: any = {}

  if (clinicId) where.clinicId = clinicId
  if (employeeId) where.employeeId = employeeId
  if (punchType) where.punchType = punchType

  if (startDate || endDate) {
    where.punchTime = {}
    if (startDate) where.punchTime.gte = new Date(startDate)
    if (endDate) where.punchTime.lte = new Date(endDate)
  }

  // MANAGER only sees their clinics
  if (session.role === 'MANAGER' && session.clinics.length > 0) {
    where.clinicId = { in: session.clinics }
  }

  const [records, total] = await Promise.all([
    prisma.punchRecord.findMany({
      where,
      include: {
        employee: {
          include: {
            user: { select: { id: true, name: true, phone: true } },
          },
        },
        clinic: { select: { id: true, name: true } },
        corrections: {
          where: { status: 'APPROVED' },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { punchTime: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.punchRecord.count({ where }),
  ])

  return NextResponse.json({
    records,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  })
}
