/**
 * POST /api/provider-referrals/[id]/reset — Reset referral to DRAFT (OWNER / provider_payout)
 * Reverts a CONFIRMED referral back to DRAFT status (MD-U)
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

  const referral = await prisma.providerReferral.findUnique({
    where: { id: params.id },
  })
  if (!referral) {
    return NextResponse.json({ error: 'Record not found' }, { status: 404 })
  }

  // Check if locked in payout run
  if (referral.lockedByRunId) {
    return NextResponse.json(
      { error: '該轉介已鎖定喺月結單中，請先解鎖月結單' },
      { status: 409 },
    )
  }

  await prisma.providerReferral.update({
    where: { id: params.id },
    data: { status: 'DRAFT' },
  })

  return NextResponse.json({ ok: true })
}
