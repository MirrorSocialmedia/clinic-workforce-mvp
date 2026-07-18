export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/punch/my-records — Current employee's punch records
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  // Get employeeId for the current user
  const emp = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })
  if (!emp) {
    return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })
  }

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')

  const where: any = { employeeId: emp.id } // Always filter by own employee

  if (clinicId) where.clinicId = clinicId

  if (startDate || endDate) {
    where.punchTime = {}
    if (startDate) where.punchTime.gte = new Date(startDate)
    if (endDate) where.punchTime.lte = new Date(endDate)
  }

  const records = await prisma.punchRecord.findMany({
    where: { ...where, void: { is: null } },
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
