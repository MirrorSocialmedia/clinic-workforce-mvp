/**
 * PUT /api/provider-referrals/[id] — Update referral (OWNER / provider_payout)
 * DELETE /api/provider-referrals/[id] — Delete referral (OWNER / provider_payout)
 * // ownership-ok: provider_payout 權限限制
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error

  const referral = await prisma.providerReferral.findUnique({
    where: { id: params.id },
  })
  if (!referral) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Check if locked
  if (referral.lockedByRunId) {
    return NextResponse.json(
      { error: '該轉介已鎖定喺月結單中，無法修改' },
      { status: 409 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const { unitPrice, qty, refPercent, itemDes, note } = body

  const refPercentNum = refPercent ?? Number(referral.refPercent)
  const qtyNum = qty ?? referral.qty
  const unitPriceNum = unitPrice != null ? Number(unitPrice) : Number(referral.unitPrice)
  const amount = Number(((unitPriceNum * qtyNum * refPercentNum / 100).toFixed(2)))

  const updated = await prisma.providerReferral.update({
    where: { id: params.id },
    data: {
      unitPrice: unitPrice != null ? unitPriceNum : undefined,
      qty: qty != null ? qtyNum : undefined,
      refPercent: refPercent != null ? refPercentNum : undefined,
      itemDes: itemDes != null ? itemDes : undefined,
      note: note != null ? note : undefined,
      amount,
    },
  })

  return NextResponse.json({
    referral: {
      ...updated,
      unitPrice: Number(updated.unitPrice),
      refPercent: Number(updated.refPercent),
      amount: Number(updated.amount),
    },
  })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error

  const referral = await prisma.providerReferral.findUnique({
    where: { id: params.id },
  })
  if (!referral) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Check if locked
  if (referral.lockedByRunId) {
    return NextResponse.json(
      { error: '該轉介已鎖定喺月結單中，無法刪除' },
      { status: 409 },
    )
  }

  await prisma.providerReferral.delete({
    where: { id: params.id },
  })

  // Audit
  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'REFERRAL_DELETE',
      entity: 'ProviderReferral',
      entityId: params.id,
      notes: `刪除轉介：${referral.itemDes} ${referral.periodMonth}`,
    },
  }).catch((e: any) => console.error('[provider-referrals] delete audit failed', e))

  return NextResponse.json({ success: true })
}
