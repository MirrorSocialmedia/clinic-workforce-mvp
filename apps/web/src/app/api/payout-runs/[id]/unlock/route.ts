/**
 * POST /api/payout-runs/[id]/unlock — Unlock a payout run (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { unlockPayoutRun } from '@/lib/payout/engine'
import { prisma } from '@/lib/prisma'
import { payoutRecordGuard } from '@/lib/payout/kiosk-scope'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({}))
  const { reason } = body

  if (!reason) {
    return NextResponse.json({ error: '解鎖必須提供理由' }, { status: 400 })
  }

  // ★ cwm-kioskpayout-20261010：店舖帳號只可以解鎖自己店
  const denied = await payoutRecordGuard(auth.session!, () => prisma.payoutRun.findUnique({ where: { id: params.id }, select: { clinicId: true } }))
  if (denied) return denied

  try {
    await unlockPayoutRun(params.id, auth.session!.userId, reason)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
