/**
 * POST /api/payout-runs/[id]/unlock — Unlock a payout run (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { unlockPayoutRun } from '@/lib/payout/engine'

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

  try {
    await unlockPayoutRun(params.id, auth.session!.userId, reason)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
