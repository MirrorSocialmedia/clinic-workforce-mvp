import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/consultation-revenue — List consultation revenue records
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const clinicId = searchParams.get('clinicId')
  const month = searchParams.get('month') // YYYY-MM

  const where: any = {}
  if (employeeId) where.employeeId = employeeId
  if (clinicId) where.clinicId = clinicId
  if (month) {
    const monthStart = new Date(`${month}-01T00:00:00`)
    const monthEnd = new Date(`${month}-01T23:59:59`)
    where.month = { gte: monthStart, lte: monthEnd }
  }

  // Scope filter
  if (scope === 'my-clinics' && session.clinics.length > 0) {
    where.clinicId = { in: session.clinics }
  }

  const records = await prisma.consultationRevenue.findMany({
    where,
    orderBy: { month: 'desc' },
  })

  return NextResponse.json({ records })
}

// ============================================================
// POST /api/consultation-revenue — Create consultation revenue
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
      const { employeeId, clinicId, month, amount, source } = body

      if (!employeeId || !clinicId || !month || amount === undefined) {
        return NextResponse.json(
          { error: 'employeeId, clinicId, month (YYYY-MM), and amount are required' },
          { status: 400 }
        )
      }

      const monthDate = new Date(`${month}-01T00:00:00`)

      const record = await prisma.consultationRevenue.upsert({
        where: {
          employeeId_clinicId_month: { employeeId, clinicId, month: monthDate },
        },
        create: {
          employeeId,
          clinicId,
          month: monthDate,
          amount,
          source: source || null,
        },
        update: {
          amount,
          source: source || null,
        },
      })

      return NextResponse.json({ success: true, record }, { status: 201 })
    } catch (error) {
      console.error('Consultation revenue error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
