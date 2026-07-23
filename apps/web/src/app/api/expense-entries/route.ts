import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/expense-entries — List expense entries
// Roles: OWNER, MANAGER, ACCOUNTANT
// Query: ?periodMonth=2026-07&clinicId=xxx
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const periodMonth = searchParams.get('periodMonth')
  const clinicId = searchParams.get('clinicId')

  const where: any = {}
  if (periodMonth) where.periodMonth = periodMonth
  if (clinicId) where.clinicId = clinicId

  // MANAGER only sees their clinics
  if (scope === 'my-clinics' && session.clinics && session.clinics.length > 0) {
    where.clinicId = { in: session.clinics }
  }

  const entries = await prisma.expenseEntry.findMany({
    where,
    include: {
      employee: {
        include: { user: { select: { id: true, name: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({ entries })
}

// ============================================================
// POST /api/expense-entries — Create an expense entry
// Roles: OWNER, MANAGER, ACCOUNTANT (payroll_generate)
// Body: { employeeId, periodMonth, amount, description }
// ============================================================
export async function POST(req: NextRequest) {
  const permCheck = await requirePerm(req, 'payroll_generate')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const body = await req.json()
  const { employeeId, periodMonth, amount, description } = body

  if (!employeeId || !periodMonth || amount == null || !description) {
    return NextResponse.json(
      { error: 'employeeId, periodMonth, amount, description are required' },
      { status: 400 }
    )
  }

  // Auto-resolve clinic from employee's primary clinic
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: { clinics: true },
  })

  if (!employee) {
    return NextResponse.json({ error: '員工不存在' }, { status: 404 })
  }

  const clinicId = employee.clinics?.[0]?.clinicId || null

  const entry = await prisma.expenseEntry.create({
    data: {
      employeeId,
      periodMonth,
      amount: parseFloat(amount),
      description,
      createdBy: session.userId,
      clinicId,
    },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'EXPENSE_CREATE',
      entity: 'ExpenseEntry',
      entityId: entry.id,
      targetEmployeeId: employeeId,
      beforeJson: null,
      afterJson: JSON.stringify({ amount, description, periodMonth }),
      notes: `${description} $${Number(amount).toLocaleString()}（${periodMonth}）`,
    },
  } as any)

  return NextResponse.json({ entry }, { status: 201 })
}
