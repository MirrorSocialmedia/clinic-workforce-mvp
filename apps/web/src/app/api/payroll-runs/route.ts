import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { generatePayrollRun } from '@/lib/payroll-engine'

// ============================================================
// GET /api/payroll-runs — List payroll runs
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const periodMonth = searchParams.get('periodMonth')
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
  if (scope === 'my-clinics' && session.clinics.length > 0) {
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
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()
      const { periodMonth, clinicId } = body

      if (!periodMonth) {
        return NextResponse.json({ error: 'periodMonth (YYYY-MM) is required' }, { status: 400 })
      }

      const result = await generatePayrollRun(clinicId || null, periodMonth, auditCtx)

      return NextResponse.json(result, { status: 201 })
    } catch (err: any) {
      console.error('Failed to generate payroll:', err)
      return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 })
    }
  })
}
