import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma, createAuditLog } from '@/lib/prisma'
import { generatePayrollRun } from '@/lib/payroll-engine'

// ============================================================
// GET /api/payroll-runs — List payroll runs
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
  const periodMonth = searchParams.get('periodMonth') // YYYY-MM
  const status = searchParams.get('status')
  const page = parseInt(searchParams.get('page') || '1')
  const pageSize = parseInt(searchParams.get('pageSize') || '20')
  const skip = (page - 1) * pageSize

  const where: any = {}

  if (clinicId) where.clinicId = clinicId
  if (status) where.status = status
  if (periodMonth) {
    const monthStart = new Date(`${periodMonth}-01T00:00:00`)
    const monthEnd = new Date(`${periodMonth}-01T23:59:59`)
    where.periodMonth = { gte: monthStart, lte: monthEnd }
  }

  // MANAGER only sees their clinics
  if (session.role === 'MANAGER' && session.clinics.length > 0) {
    where.OR = [
      { clinicId: { in: session.clinics } },
      ...session.clinics.map((cid: string) => ({ clinicId: cid })),
    ]
    // Simplified: manager sees runs for their clinics or null (all clinics)
    where.clinicId = { in: [...session.clinics, null] }
  }

  const [runs, total] = await Promise.all([
    prisma.payrollRun.findMany({
      where,
      include: {
        clinic: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
      orderBy: { periodMonth: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.payrollRun.count({ where }),
  ])

  return NextResponse.json({
    runs,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  })
}

// ============================================================
// POST /api/payroll-runs — Generate payroll run
// Roles: OWNER
// ============================================================
export async function POST(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Forbidden: OWNER only' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const { periodMonth, clinicId } = body

    if (!periodMonth) {
      return NextResponse.json({ error: 'periodMonth (YYYY-MM) is required' }, { status: 400 })
    }

    const result = await generatePayrollRun(clinicId || null, periodMonth)

    await createAuditLog({
      action: 'CREATE_PAYROLL_RUN',
      entity: 'PayrollRun',
      entityId: result.runId,
      notes: `Generated payroll for ${periodMonth}${clinicId ? ` clinic ${clinicId}` : ' all clinics'}: ${result.itemCount} employees, HK$${result.totalPayable.toFixed(2)}`,
    })

    return NextResponse.json(result, { status: 201 })
  } catch (err: any) {
    console.error('Failed to generate payroll:', err)
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 })
  }
}
