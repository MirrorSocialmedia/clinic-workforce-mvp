/**
 * POST /api/sp-subsidies/[id]/confirm — Confirm SP subsidy (OWNER / provider_payout)
 * // ownership-ok: provider_payout 權限限制
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const subsidy = await prisma.spSubsidy.findUnique({
    where: { id: params.id },
  })
  if (!subsidy) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Check if locked
  if (subsidy.lockedByRunId) {
    return NextResponse.json(
      { error: '該補貼已鎖定喺月結單中，無法修改' },
      { status: 409 },
    )
  }

  const updated = await prisma.spSubsidy.update({
    where: { id: params.id },
    data: { confirmedBy: auth.session!.userId },
  })

  // Audit
  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'SP_SUBSIDY_CONFIRM',
      entity: 'SpSubsidy',
      entityId: params.id,
      notes: `確認 SP 補貼：${updated.itemDes} ${updated.periodMonth} $${Number(updated.amount)}`,
      afterJson: JSON.stringify({
        providerId: updated.providerId,
        periodMonth: updated.periodMonth,
        amount: Number(updated.amount),
      }),
    },
  }).catch((e: any) => console.error('[sp-subsidies] confirm audit failed', e))

  return NextResponse.json({
    subsidy: {
      ...updated,
      listPrice: Number(updated.listPrice),
      actualPrice: Number(updated.actualPrice),
      splitPercent: Number(updated.splitPercent),
      amount: Number(updated.amount),
    },
  })
}
