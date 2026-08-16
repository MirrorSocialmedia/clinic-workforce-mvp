/**
 * POST /api/payout-runs/[id]/lock — Lock a payout run (OWNER / provider_payout)
 * // ownership-ok: PayoutRun 冇 clinic/employee 歸屬；route 已 requirePerm('provider_payout') = OWNER only
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma, basePrisma } from '@/lib/prisma'
import { computePayout, lockPayoutRun } from '@/lib/payout/engine'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const run = await prisma.payoutRun.findUnique({ where: { id: params.id } })
  if (!run) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (run.status === 'LOCKED') {
    return NextResponse.json({ error: 'Already locked' }, { status: 409 })
  }

  // Update status to LOCKED and lock related records
  const updated = await basePrisma.$transaction(async (tx: any) => {
    // Update run status
    const updated = await tx.payoutRun.update({
      where: { id: params.id },
      data: { status: 'LOCKED', lockedAt: new Date() },
    })

    // Lock CostCase
    const lockCostWhere: any = {
      providerId: run.providerId,
      periodMonth: run.periodMonth,
      status: { not: 'VOID' },
      lockedByRunId: null,
    }
    if (run.clinicId) lockCostWhere.clinicId = run.clinicId
    await tx.costCase.updateMany({
      where: lockCostWhere,
      data: { lockedByRunId: updated.id },
    })

    // Lock ProviderReferral
    const lockRefWhere: any = {
      fromProviderId: run.providerId,
      periodMonth: run.periodMonth,
      lockedByRunId: null,
    }
    if (run.clinicId) lockRefWhere.clinicId = run.clinicId
    await tx.providerReferral.updateMany({
      where: lockRefWhere,
      data: { lockedByRunId: updated.id },
    })

    // Lock SpSubsidy
    const lockSpWhere: any = {
      providerId: run.providerId,
      periodMonth: run.periodMonth,
      lockedByRunId: null,
    }
    if (run.clinicId) lockSpWhere.clinicId = run.clinicId
    await tx.spSubsidy.updateMany({
      where: lockSpWhere,
      data: { lockedByRunId: updated.id },
    })

    // Assign unassigned adjustments
    const lockAdjWhere: any = {
      providerId: run.providerId,
      periodMonth: run.periodMonth,
      runId: null,
    }
    if (run.clinicId) lockAdjWhere.clinicId = run.clinicId
    await tx.payoutAdjustment.updateMany({
      where: lockAdjWhere,
      data: { runId: updated.id },
    })

    // Write audit log
    await tx.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PAYOUT_RUN_LOCK',
        entity: 'PayoutRun',
        entityId: updated.id,
        notes: `鎖定月結單：${run.periodMonth}`,
        afterJson: JSON.stringify({
          providerId: run.providerId,
          periodMonth: run.periodMonth,
          totalAmount: Number(run.totalAmount),
        }),
      },
    })

    return updated
  })

  return NextResponse.json({ run: updated })
}
