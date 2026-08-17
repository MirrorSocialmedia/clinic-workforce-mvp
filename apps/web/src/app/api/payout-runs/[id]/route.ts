/**
 * GET /api/payout-runs/[id] — Single payout run detail (OWNER / provider_payout)
 * DELETE /api/payout-runs/[id] — Delete draft payout run (AA4)
 * // ownership-ok: 月結單數據敏感，provider_payout 權限足夠
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const run = await prisma.payoutRun.findUnique({
    where: { id: params.id },
  })

  if (!run) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const provider = await prisma.provider.findUnique({
    where: { id: run.providerId },
    select: { id: true, name: true, shortName: true },
  })

  const clinic = run.clinicId
    ? await prisma.clinic.findUnique({
        where: { id: run.clinicId },
        select: { id: true, name: true, shortName: true },
      })
    : null

  const adjustments = await prisma.payoutAdjustment.findMany({
    where: { runId: params.id },
  })

  return NextResponse.json({
    run: {
      ...run,
      provider,
      clinic,
      grossAmount: Number(run.grossAmount),
      rawAmount: Number(run.rawAmount),
      labCost: Number(run.labCost),
      implantCost: Number(run.implantCost),
      invisalignCost: Number(run.invisalignCost),
      profitAmount: Number(run.profitAmount),
      percentUsed: Number(run.percentUsed),
      salaryAmount: Number(run.salaryAmount),
      spSubsidy: Number(run.spSubsidy),
      refAmount: Number(run.refAmount),
      adjustAmount: Number(run.adjustAmount),
      totalAmount: Number(run.totalAmount),
      adjustments: adjustments.map((a: any) => ({
        ...a,
        amount: Number(a.amount),
      })),
    },
  })
}

/**
 * DELETE /api/payout-runs/[id] — Delete draft payout run (AA4)
 * 解除四張表的 lockedByRunId / runId，再刪 PayoutRun
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error

  const id = (await params).id
  const run = await prisma.payoutRun.findUnique({ where: { id } })
  if (!run) return jsonNoStore({ error: '月結單不存在' }, { status: 404 })

  if (run.status === 'LOCKED') {
    return jsonNoStore({ error: '已鎖定嘅月結單唔可以刪，請先解鎖' }, { status: 409 })
  }

  await prisma.$transaction(async (tx: any) => {
    await tx.costCase.updateMany({ where: { lockedByRunId: run.id }, data: { lockedByRunId: null } })
    await tx.providerReferral.updateMany({ where: { lockedByRunId: run.id }, data: { lockedByRunId: null } })
    await tx.spSubsidy.updateMany({ where: { lockedByRunId: run.id }, data: { lockedByRunId: null } })
    await tx.payoutAdjustment.updateMany({ where: { runId: run.id }, data: { runId: null } })
    await tx.payoutRun.delete({ where: { id: run.id } })
  })

  await prisma.auditLog.create({ data: {
    actorId: auth.session!.userId,
    action: 'PAYOUT_RUN_DELETE',
    entity: 'PayoutRun',
    entityId: run.id,
    notes: `刪除草稿月結單：${run.periodMonth} · 總額 $${Number(run.totalAmount)}`,
    beforeJson: JSON.stringify(run),
  }})

  return jsonNoStore({ success: true })
}
