// ============================================================
// ★ cwm-costdetail-20261006：GET /api/payout-runs/stale-costs — 醫生月結頁「成本異常」
//   落單超過 60 日、仍未到貨、未作廢（LAB／INVISALIGN），全部醫生同診所；最舊排最前
//   權限同醫生月結頁（OWNER / provider_payout）；病人只出編號
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { todayHK } from '@/lib/hk-date'
import { STALE_DAYS, staleCostCases } from '@/lib/payout/cost-detail'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  return handleRoute('payout-stale-costs', async () => {
    const rows = await staleCostCases(todayHK(), null)
    return jsonNoStore({ days: STALE_DAYS, rows })
  })
}
