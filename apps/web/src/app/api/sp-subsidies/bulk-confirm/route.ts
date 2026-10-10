/**
 * POST /api/sp-subsidies/bulk-confirm — 批量確認 2人SP補貼（OWNER / provider_payout）
 * // ownership-ok: provider_payout 權限限制
 * ★ cwm-spbulk-20261006：body { items: [{ id, amount }] } —— amount = 用戶睇到嘅金額；
 *   只確認「仍然待確認、未鎖定、金額冇變」嘅，成批一個 transaction；其餘逐筆回原因。
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { bulkConfirmSp, parseBulkItems } from '@/lib/payout/sp-status'
import { prisma } from '@/lib/prisma'
import { payoutClinicLimit, payoutClinicAllowed, PAYOUT_CLINIC_FORBIDDEN } from '@/lib/payout/kiosk-scope'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({} as any))
  let items
  try {
    items = parseBulkItems(body?.items)
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? 'BULK_INVALID').replace(/^BULK_\w+: /, '') }, { status: 400 })
  }
  // ★ cwm-kioskpayout-20261010：店舖帳號 —— 成批入面有一筆唔係自己店就成批拒絕
  if (payoutClinicLimit(auth.session!)) {
    const recs = await prisma.spSubsidy.findMany({ where: { id: { in: items.map(i => i.id) } }, select: { clinicId: true } })
    const bad = recs.find(r => !payoutClinicAllowed(auth.session!, r.clinicId))
    if (bad) return NextResponse.json({ error: PAYOUT_CLINIC_FORBIDDEN }, { status: 403 })
  }
  try {
    const r = await bulkConfirmSp(items, auth.session!.userId)
    return NextResponse.json(r)
  } catch (e: any) {
    console.error('[sp-subsidies] bulk-confirm failed', e)
    return NextResponse.json({ error: '批量確認失敗，冇任何一筆被確認，請重試' }, { status: 500 })
  }
}
