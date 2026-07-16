export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { getMonthRange } from '@/lib/hk-date'

// GET /api/payroll-runs/[id]/employee/[empId] — Single employee payroll detail
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; empId: string } }
) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const item = await prisma.payrollItem.findUnique({
    where: { runId_employeeId: { runId: params.id, employeeId: params.empId } },
    include: {
      run: {
        include: {
          clinic: {
            select: {
              id: true,
              name: true,
              company: { select: { logoData: true } },
            },
          },
        },
      },
      employee: {
        select: {
          payConfidential: true,
          user: { select: { id: true, name: true, phone: true } },
          clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
          payRules: { where: { isActive: true }, orderBy: { effectiveFrom: 'desc' }, take: 1 },
        },
      },
    },
  })

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Server-side confidentiality check
  const isOwner = session.role === 'OWNER'
  if (!isOwner && item.employee.payConfidential) {
    return NextResponse.json({ error: '此員工薪資已設保密' }, { status: 403 })
  }

  const detail = item.detailJson ? JSON.parse(item.detailJson) : null

  const periodStart = new Date(item.run.periodMonth)
  const { end: periodEnd } = getMonthRange(periodStart)

  const punches = await prisma.punchRecord.findMany({
    where: { employeeId: params.empId, punchTime: { gte: periodStart, lte: periodEnd }, void: { is: null } },
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
    periodMonth: item.run.periodMonth.toISOString(),
  })
}
