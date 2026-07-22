export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { generatePayrollRun } from '@/lib/payroll-engine'
import { getMonthRange } from '@/lib/hk-date'

// ============================================================
// GET /api/payroll-runs — List payroll runs
// Roles: OWNER, MANAGER, ACCOUNTANT (payroll_view permission)
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'payroll_view')
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
    const { start: monthStart, end: monthEnd } = getMonthRange(new Date(`${periodMonth}-01T00:00:00+08:00`))
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
// Roles: OWNER, MANAGER (payroll_generate permission)
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requirePerm(req, 'payroll_generate')
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
      const { periodMonth, clinicId, storeBonuses, splitPays } = body

      if (!periodMonth) {
        return NextResponse.json({ error: 'periodMonth (YYYY-MM) is required' }, { status: 400 })
      }
      if (!clinicId) {
        return NextResponse.json({ error: '請指定店鋪（每店營業獎金不同，不支援全店合併生成）' }, { status: 400 })
      }

      // Validate storeBonuses if provided
      if (storeBonuses) {
        for (const [k, v] of Object.entries(storeBonuses)) {
          if (typeof v !== 'number' || !isFinite(v) || v < 0) {
            return NextResponse.json({ error: `Invalid storeBonus for ${k}: must be a finite non-negative number` }, { status: 400 })
          }
        }
      }

      // Validate splitPays if provided
      if (splitPays) {
        for (const [k, v] of Object.entries(splitPays)) {
          if (typeof v !== 'number' || !isFinite(v) || v < 0) {
            return NextResponse.json({ error: `Invalid splitPay for ${k}: must be a finite non-negative number` }, { status: 400 })
          }
        }
      }

      const result = await generatePayrollRun(clinicId || null, periodMonth, auditCtx, storeBonuses, splitPays)

      // FIX #2: If result has error field (e.g., CONFIRMED blocked), return 409
      if ((result as any).error) {
        return NextResponse.json(result, { status: 409 })
      }

      return NextResponse.json(result, { status: 201 })
    } catch (err: any) {
      console.error('Failed to generate payroll:', err)
      return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 })
    }
  })
}
