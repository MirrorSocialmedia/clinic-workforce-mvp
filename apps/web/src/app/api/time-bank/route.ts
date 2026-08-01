import { NextRequest, NextResponse } from 'next/server'
import { prisma, basePrisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { calculateTimeBank, persistTimeBank } from '@/lib/payroll-engine'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/time-bank — List time bank records
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const periodMonth = searchParams.get('periodMonth') // YYYY-MM

  const where: any = {}
  if (employeeId && scope !== 'self') where.employeeId = employeeId
  if (scope === 'self') {
    const emp = await prisma.employee.findUnique({ where: { userId: session.userId } })
    if (!emp) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })
    // ★ 明确拒绝，唔好静静回自己的
    if (employeeId && employeeId !== emp.id) {
      return NextResponse.json(
        { error: 'Forbidden (cannot read other employees\' time bank)' },
        { status: 403 },
      )
    }
    where.employeeId = emp.id
  }
  if (periodMonth) {
    const [yearStr, monthStr] = periodMonth.split('-')
    const monthDate = new Date(`${yearStr}-${monthStr.padStart(2, '0')}-01T00:00:00+08:00`)
    where.periodMonth = monthDate
  }

  const records = await prisma.timeBank.findMany({
    where,
    include: {
      employee: {
        include: {
          user: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ periodMonth: 'desc' }, { employeeId: 'asc' }],
    take: 500,
  })

  return jsonNoStore({ timeBank: records })
}

// ============================================================
// POST /api/time-bank — Calculate / upsert time bank record
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
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
      const { employeeId, periodMonth, negative_carry } = body

      if (!employeeId || !periodMonth) {
        return NextResponse.json(
          { error: 'employeeId and periodMonth (YYYY-MM) are required' },
          { status: 400 }
        )
      }

      const [yearStr, monthStr] = periodMonth.split('-')
      const monthDate = new Date(`${yearStr}-${monthStr.padStart(2, '0')}-01T00:00:00+08:00`)

      // Calculate time bank data
      const result = await calculateTimeBank(
        employeeId,
        monthDate,
        { negative_carry: negative_carry || 'next_month' },
        basePrisma
      )

      // ★ persistTimeBank guarantees all 6 fields + cacheKey written atomically
      await persistTimeBank(basePrisma, employeeId, monthDate, result)

      // Read back for response
      const record = await prisma.timeBank.findUnique({
        where: { employeeId_periodMonth: { employeeId, periodMonth: monthDate } },
      })

      return NextResponse.json({ success: true, timeBank: record }, { status: 201 })
    } catch (error) {
      console.error('Time bank calculation error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
