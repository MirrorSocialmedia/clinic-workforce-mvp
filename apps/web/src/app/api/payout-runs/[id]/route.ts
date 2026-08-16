/**
 * GET /api/payout-runs/[id] — Single payout run detail (OWNER / provider_payout)
 * // ownership-ok: 月結單數據敏感，provider_payout 權限足夠
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

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
