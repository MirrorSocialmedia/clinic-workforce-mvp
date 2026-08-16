/**
 * POST /api/sp-subsidies/scan — Auto-detect SP subsidies (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { scanSpSubsidies } from '@/lib/payout/engine'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({}))
  const { periodMonth, clinicId } = body

  if (!periodMonth) {
    return NextResponse.json({ error: 'periodMonth required' }, { status: 400 })
  }

  const result = await scanSpSubsidies(periodMonth, clinicId)

  return NextResponse.json({ candidates: result.candidates, count: result.candidates.length, skippedLocked: result.skippedLocked })
}
