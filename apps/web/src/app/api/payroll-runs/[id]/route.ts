export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma, basePrisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { getConfidentialScope } from '@/lib/scope-helpers'
import { runWithAudit } from '@/lib/audit-context'
import { snapshotWagesForADW } from '@/lib/adw'


// GET /api/payroll-runs/[id] — Payroll run detail with items
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const run = await prisma.payrollRun.findUnique({
    where: { id: params.id },
    include: {
      clinic: { select: { id: true, name: true } },
      items: {
        include: {
          employee: {
            select: {
              payConfidential: true,
              homeClinicId: true,
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

  // ★ Confidential filter — 用 getConfidentialScope 一次過算好範圍（2026-08-03）
  const perms = auth.perms ?? []
  const confidentialScope = await getConfidentialScope(session, perms)
  let items = run.items
  if (confidentialScope !== null) {
    items = items.filter((item: any) =>
      !item.employee?.payConfidential || (!!item.employee?.homeClinicId && confidentialScope.includes(item.employee.homeClinicId))
    )
  }

  // ★ Extract sickDeduction from detailJson for each item
  //   (2026-08-02: sickDeduction is stored in detailJson, not in PayrollItem.deduction)
  const itemsWithSickDeduction = items.map((it: any) => ({
    ...it,
    sickDeduction: (() => {
      try { return JSON.parse(it.detailJson || '{}').sickDeduction ?? 0 } catch { return 0 }
    })(),
  }))

  // ★ Totals recalculated from visible items only (prevents reverse-engineering)
  const summary = {
    totalEmployees: itemsWithSickDeduction.length,
    totalBasePay: itemsWithSickDeduction.reduce((s: number, i: any) => s + (i.basePay || 0), 0),
    totalOTPay: itemsWithSickDeduction.reduce((s: number, i: any) => s + (i.otPay || 0), 0),
    totalSplitPay: itemsWithSickDeduction.reduce((s: number, i: any) => s + (i.splitPay || 0), 0),
    // ★ totalDeduction includes both absent/unpaid deduction AND sick deduction (2026-08-02)
    totalDeduction: itemsWithSickDeduction.reduce(
      (s: number, i: any) => s + (i.deduction || 0) + (i.sickDeduction || 0), 0,
    ),
    totalPayable: itemsWithSickDeduction.reduce((s: number, i: any) => s + (i.totalPayable || 0), 0),
    totalWorkedHours: itemsWithSickDeduction.reduce((s: number, i: any) => s + i.workedHours, 0),
    totalOTHours: itemsWithSickDeduction.reduce((s: number, i: any) => {
      let detail: any = null
      try { detail = i.detailJson ? JSON.parse(i.detailJson) : null } catch {}
      return s + (detail?.timebank?.otMinutes ?? i.otHours * 60) / 60
    }, 0),
    totalLeaveDays: itemsWithSickDeduction.reduce((s: number, i: any) => s + i.leaveDays, 0),
    totalAbsentDays: itemsWithSickDeduction.reduce((s: number, i: any) => s + i.absentDays, 0),
  }

  return NextResponse.json({ run: { ...run, items: itemsWithSickDeduction }, summary }, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  })
}

// PUT /api/payroll-runs/[id] — Update payroll run status/notes
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
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
      const isDowngrade = order[status] < order[run.status]

      if (isDowngrade) {
        // ★ 退回草稿：只准 FINALIZED → DRAFT，OWNER 限定，必須填原因
        if (!(run.status === 'FINALIZED' && status === 'DRAFT')) {
          return NextResponse.json(
            { error: `唔支援由 ${run.status} 退回 ${status}（已匯出的計糧單唔可以退回）` },
            { status: 400 },
          )
        }
        if (session.role !== 'OWNER') { // ROLE-OK：保密員工隔離刻意用 role
          return NextResponse.json({ error: '只有 OWNER 可以退回計糧單至草稿' }, { status: 403 })
        }
        const reason = (body.reason ?? '').trim()
        if (reason.length < 5) {
          return NextResponse.json({ error: '退回草稿必須填寫原因（至少 5 個字）' }, { status: 400 })
        }
      }
    }

    // FIX #1: Use $transaction — status update + audit in same transaction
    const updated = await basePrisma.$transaction(async (tx) => {
      const result = await tx.payrollRun.update({
        where: { id: params.id },
        data: { ...(status && { status }), ...(notes !== undefined && { notes }) },
        include: { _count: { select: { items: true } }, clinic: { select: { id: true, name: true } } },
      })

      // ★★ DRAFT → FINALIZED: auto-snapshot wage records for ADW
      if (status === 'FINALIZED' && run.status === 'DRAFT') {
        await snapshotWagesForADW(tx, params.id, auditCtx.actorId)
      }

      // ★ 退回草稿：獨立 action，方便日後追查
      if (status === 'DRAFT' && run.status === 'FINALIZED') {
        await tx.auditLog.create({
          data: {
            actorId: auditCtx.actorId,
            action: 'PAYROLL_REVERT_TO_DRAFT',
            entity: 'PayrollRun',
            entityId: params.id,
            beforeJson: JSON.stringify({ status: run.status }),
            afterJson: JSON.stringify({ status: 'DRAFT' }),
            notes: `退回草稿。原因：${body.reason}`,
          },
        })
      }

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
  const auth = await requireAuth(req, 'DELETE', req.url)
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
