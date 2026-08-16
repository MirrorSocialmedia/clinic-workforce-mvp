/**
 * POST /api/sp-subsidies/[id]/reset — Reset SP subsidy to PENDING (OWNER / provider_payout)
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
    data: { status: 'PENDING', confirmedBy: null },
  })

  // Audit
  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'SP_SUBSIDY_RESET',
      entity: 'SpSubsidy',
      entityId: params.id,
      notes: `重置 SP 補貼：${updated.itemDes} ${updated.periodMonth} $${Number(updated.amount)}`,
      afterJson: JSON.stringify({
        providerId: updated.providerId,
        periodMonth: updated.periodMonth,
        amount: Number(updated.amount),
      }),
    },
  }).catch((e: any) => console.error('[sp-subsidies] reset audit failed', e))

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
