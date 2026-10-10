/**
 * POST /api/sp-subsidies/[id]/reset — Reset SP subsidy to PENDING (OWNER / provider_payout)
 * // ownership-ok: provider_payout 權限限制
 * ★ cwm-spbulk-20261006：改用 setSpStatus（條件寫入：未鎖定先寫；已經係待確認 = no-op，唔重複寫 audit）
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { setSpStatus, spStatusResponse } from '@/lib/payout/sp-status'
import { prisma } from '@/lib/prisma'
import { payoutRecordGuard } from '@/lib/payout/kiosk-scope'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  // ★ cwm-kioskpayout-20261010：店舖帳號只可以改自己店嘅補貼
  const denied = await payoutRecordGuard(auth.session!, () => prisma.spSubsidy.findUnique({ where: { id: params.id }, select: { clinicId: true } }))
  if (denied) return denied

  const r = await setSpStatus(params.id, 'PENDING', auth.session!.userId)
  const { body, status } = spStatusResponse(r)
  return NextResponse.json(body, { status })
}
