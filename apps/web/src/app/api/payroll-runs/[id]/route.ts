export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma, basePrisma } from '@/lib/prisma'
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
    // Fix #4a: 用 detailJson.timebank.otMinutes 加總（門檻制 otHours 對月薪制=0）
    totalOTHours: run.items.reduce((s, i) => {
      let detail: any = null
      try { detail = i.detailJson ? JSON.parse(i.detailJson) : null } catch {}
      return s + (detail?.timebank?.otMinutes ?? i.otHours * 60) / 60
    }, 0),
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

    // FIX #1: Use $transaction — status update + audit in same transaction
    const updated = await basePrisma.$transaction(async (tx) => {
      const result = await tx.payrollRun.update({
        where: { id: params.id },
        data: { ...(status && { status }), ...(notes !== undefined && { notes }) },
        include: { _count: { select: { items: true } }, clinic: { select: { id: true, name: true } } },
      })

      // Manual audit inside same transaction
      await tx.auditLog.create({
        data: {
          actorId: auditCtx.actorId,
          action: 'UPDATE',
          entity: 'PayrollRun',
          entityId: result.id,
          afterJson: JSON.stringify(result),
          notes: `PayrollRun status changed: ${run.status} → ${status ?? 'unchanged'}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })

      return result
    })

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

    // FIX #1: Use $transaction — delete + audit in same transaction
    await basePrisma.$transaction(async (tx) => {
      await tx.payrollRun.delete({ where: { id: params.id } })

      // Manual audit inside same transaction
      await tx.auditLog.create({
        data: {
          actorId: auditCtx.actorId,
          action: 'DELETE',
          entity: 'PayrollRun',
          entityId: params.id,
          notes: `PayrollRun deleted: ${params.id}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })
    })

    return NextResponse.json({ success: true })
  })
}
