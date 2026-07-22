export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, applyScopeFilter, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/punches — List punch records with filters
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

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

  // Data scope filtering
  const sessionClinics = session.clinics ?? []
  if (scope === 'my-clinics' && sessionClinics.length > 0) {
    where.clinicId = { in: sessionClinics }
  }

  const [records, total] = await Promise.all([
    prisma.punchRecord.findMany({
      where: {
        ...where,
        void: { is: null }, // Exclude voided punches
      },
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
        void: true, // Include void info for UI
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
