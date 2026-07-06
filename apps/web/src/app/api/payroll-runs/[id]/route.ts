import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'

// GET /api/payroll-runs/[id] — Payroll run detail with items
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const run = await prisma.payrollRun.findUnique({
    where: { id: params.id },
    include: {
      clinic: { select: { id: true, name: true } },
      items: {
        include: {
          employee: {
            include: {
              user: { select: { id: true, name: true, phone: true } },
              clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
              payRules: { where: { isActive: true }, take: 1 },
            },
          },
        },
        orderBy: { employeeId: 'asc' },
      },
    },
  })

  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const summary = {
    totalEmployees: run.items.length,
    totalBasePay: run.items.reduce((s, i) => s + i.basePay, 0),
    totalOTPay: run.items.reduce((s, i) => s + i.otPay, 0),
    totalSplitPay: run.items.reduce((s, i) => s + (i.splitPay || 0), 0),
    totalDeduction: run.items.reduce((s, i) => s + i.deduction, 0),
    totalPayable: run.items.reduce((s, i) => s + i.totalPayable, 0),
    totalWorkedHours: run.items.reduce((s, i) => s + i.workedHours, 0),
    totalOTHours: run.items.reduce((s, i) => s + i.otHours, 0),
    totalLeaveDays: run.items.reduce((s, i) => s + i.leaveDays, 0),
    totalAbsentDays: run.items.reduce((s, i) => s + i.absentDays, 0),
  }

  return NextResponse.json({ run, summary })
}

// PUT /api/payroll-runs/[id] — Update payroll run status/notes
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const run = await prisma.payrollRun.findUnique({ where: { id: params.id } })
    if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json()
    const { status, notes } = body

    if (status) {
      const validStatuses = ['DRAFT', 'FINALIZED', 'EXPORTED'] as const
      if (!validStatuses.includes(status as any)) {
        return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 })
      }
      const order: Record<string, number> = { DRAFT: 0, FINALIZED: 1, EXPORTED: 2 }
      if (order[status] < order[run.status]) {
        return NextResponse.json({ error: `Cannot downgrade status from ${run.status} to ${status}` }, { status: 400 })
      }
    }

    const updated = await prisma.payrollRun.update({
      where: { id: params.id },
      data: { ...(status && { status }), ...(notes !== undefined && { notes }) },
      include: { _count: { select: { items: true } }, clinic: { select: { id: true, name: true } } },
    })

    // Audit handled by Prisma extension (PayrollRun ∈ AUDIT_ENTITIES)

    return NextResponse.json(updated)
  })
}

// DELETE /api/payroll-runs/[id] — Delete payroll run
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const run = await prisma.payrollRun.findUnique({ where: { id: params.id } })
    if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (run.status !== 'DRAFT') {
      return NextResponse.json({ error: 'Can only delete DRAFT payroll runs' }, { status: 400 })
    }

    await prisma.payrollRun.delete({ where: { id: params.id } })

    // Audit handled by Prisma extension (PayrollRun ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true })
  })
}
