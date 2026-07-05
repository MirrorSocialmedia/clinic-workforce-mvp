import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma, createAuditLog } from '@/lib/prisma'

// ============================================================
// GET /api/payroll-runs/[id] — Payroll run detail with items
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const run = await prisma.payrollRun.findUnique({
    where: { id: params.id },
    include: {
      clinic: { select: { id: true, name: true } },
      items: {
        include: {
          employee: {
            include: {
              user: { select: { id: true, name: true, phone: true } },
              clinics: {
                select: {
                  clinicId: true,
                  clinic: { select: { name: true } },
                },
              },
              payRules: {
                where: { isActive: true },
                take: 1,
              },
            },
          },
        },
        orderBy: { employeeId: 'asc' },
      },
    },
  })

  if (!run) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Calculate summary
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

// ============================================================
// PUT /api/payroll-runs/[id] — Update payroll run status/notes
// Roles: OWNER
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Forbidden: OWNER only' }, { status: 403 })
  }

  const run = await prisma.payrollRun.findUnique({
    where: { id: params.id },
  })

  if (!run) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = await req.json()
  const { status, notes } = body

  // Validate transitions
  if (status) {
    const validStatuses = ['DRAFT', 'FINALIZED', 'EXPORTED'] as const
    if (!validStatuses.includes(status as any)) {
      return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 })
    }
    // Can only go forward: DRAFT -> FINALIZED -> EXPORTED
    const order: Record<string, number> = { DRAFT: 0, FINALIZED: 1, EXPORTED: 2 }
    if (order[status] < order[run.status]) {
      return NextResponse.json({ error: `Cannot downgrade status from ${run.status} to ${status}` }, { status: 400 })
    }
  }

  const updated = await prisma.payrollRun.update({
    where: { id: params.id },
    data: {
      ...(status && { status }),
      ...(notes !== undefined && { notes }),
    },
    include: {
      _count: { select: { items: true } },
      clinic: { select: { id: true, name: true } },
    },
  })

  await createAuditLog({
    action: 'UPDATE_PAYROLL_RUN',
    entity: 'PayrollRun',
    entityId: params.id,
    notes: `Updated payroll run: ${status ? `status=${status}` : ''} ${notes ? `notes="${notes}"` : ''}`,
  })

  return NextResponse.json(updated)
}

// ============================================================
// DELETE /api/payroll-runs/[id] — Delete payroll run
// Roles: OWNER, only DRAFT status
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Forbidden: OWNER only' }, { status: 403 })
  }

  const run = await prisma.payrollRun.findUnique({
    where: { id: params.id },
  })

  if (!run) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (run.status !== 'DRAFT') {
    return NextResponse.json({ error: 'Can only delete DRAFT payroll runs' }, { status: 400 })
  }

  await prisma.payrollRun.delete({
    where: { id: params.id },
  })

  await createAuditLog({
    action: 'DELETE_PAYROLL_RUN',
    entity: 'PayrollRun',
    entityId: params.id,
    notes: `Deleted DRAFT payroll run for ${run.periodMonth.toISOString().slice(0, 7)}`,
  })

  return NextResponse.json({ success: true })
}
