export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/payroll-runs/[id]/employee/[empId] — Single employee payroll detail
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; empId: string } }
) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const item = await prisma.payrollItem.findUnique({
    where: { runId_employeeId: { runId: params.id, employeeId: params.empId } },
    include: {
      run: { include: { clinic: { select: { id: true, name: true } } } },
      employee: {
        include: {
          user: { select: { id: true, name: true, phone: true } },
          clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
          payRules: { where: { isActive: true }, orderBy: { effectiveFrom: 'desc' }, take: 1 },
        },
      },
    },
  })

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const detail = item.detailJson ? JSON.parse(item.detailJson) : null

  const periodStart = new Date(item.run.periodMonth)
  const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 0, 23, 59, 59)

  const punches = await prisma.punchRecord.findMany({
    where: { employeeId: params.empId, punchTime: { gte: periodStart, lte: periodEnd } },
    orderBy: { punchTime: 'asc' },
    take: 100,
  })

  const leaves = await prisma.leaveRequest.findMany({
    where: {
      employeeId: params.empId, status: 'APPROVED',
      startDate: { lte: periodEnd }, endDate: { gte: periodStart },
    },
    include: { leaveType: { select: { name: true, isPaid: true } } },
  })

  const corrections = await prisma.punchCorrection.findMany({
    where: {
      employeeId: params.empId, status: 'APPROVED',
      correctedTime: { gte: periodStart, lte: periodEnd },
    },
    orderBy: { correctedTime: 'asc' },
  })

  return NextResponse.json({
    item, detail, punches, leaves, corrections,
    periodMonth: item.run.periodMonth.toISOString().slice(0, 7),
  })
}
