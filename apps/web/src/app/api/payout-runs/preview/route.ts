/**
 * POST /api/payout-runs/preview — Preview payout without locking (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runGates, computePayout } from '@/lib/payout/engine'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({}))
  const { providerId, periodMonth } = body

  if (!providerId || !periodMonth) {
    return NextResponse.json({ error: 'providerId and periodMonth required' }, { status: 400 })
  }

  // Run gates
  const { errors, warnings } = await runGates(providerId, periodMonth)
  if (errors.length > 0) {
    return NextResponse.json({ errors, warnings }, { status: 400 })
  }

  // Compute
  let payout: any
  try {
    payout = await computePayout(providerId, periodMonth)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }

  return NextResponse.json({
    preview: payout,
    warnings: [...warnings, ...payout.warnings],
  })
}
