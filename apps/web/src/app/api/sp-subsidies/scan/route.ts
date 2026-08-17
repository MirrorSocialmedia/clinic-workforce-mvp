/**
 * POST /api/sp-subsidies/scan — Auto-detect SP subsidies (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { handleRoute } from '@/lib/api-guard'
import { scanSpSubsidies } from '@/lib/payout/engine'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  return handleRoute('sp-subsidies/scan', async () => {
    const { periodMonth, clinicId } = await req.json().catch(() => ({}))
    if (!periodMonth) return NextResponse.json({ error: 'periodMonth required' }, { status: 400 })
    const r = await scanSpSubsidies(periodMonth, clinicId)
    return NextResponse.json({
      candidates: r.candidates,
      count: r.candidates.length,
      skippedLocked: r.skippedLocked,
      created: r.created,
      updated: r.updated,
      failed: r.failed,
    })
  })
}
