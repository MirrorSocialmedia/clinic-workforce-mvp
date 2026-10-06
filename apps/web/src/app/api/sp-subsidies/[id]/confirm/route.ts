/**
 * POST /api/sp-subsidies/[id]/confirm — Confirm SP subsidy (OWNER / provider_payout)
 * // ownership-ok: provider_payout 權限限制
 * ★ cwm-spbulk-20261006：改用 setSpStatus（條件寫入：未鎖定先寫；已經係已確認 = no-op，唔重複寫 audit）
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { setSpStatus, spStatusResponse } from '@/lib/payout/sp-status'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const r = await setSpStatus(params.id, 'CONFIRMED', auth.session!.userId)
  const { body, status } = spStatusResponse(r)
  return NextResponse.json(body, { status })
}
