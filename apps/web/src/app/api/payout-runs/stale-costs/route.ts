// ============================================================
// ★ cwm-costdetail-20261006：GET /api/payout-runs/stale-costs — 醫生月結頁「成本異常」
//   落單超過 60 日、仍未到貨、未作廢（LAB／INVISALIGN），全部醫生同診所；最舊排最前
//   ＋ orphans：已鎖月結月份入面但冇計入嘅成本（cwm-costguard-20261006）
//   ＋ unpriced：到貨月份早過上月仍未有價錢（cwm-lastmonth-20261006）
//   權限同醫生月結頁（OWNER / provider_payout）；病人只出編號
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { todayHK } from '@/lib/hk-date'
import { STALE_DAYS, staleCostCases, orphanCostCases, oldUnpricedCostCases } from '@/lib/payout/cost-detail'
import { payoutClinicLimit } from '@/lib/payout/kiosk-scope'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  return handleRoute('payout-stale-costs', async () => {
    const today = todayHK()
    const lim = payoutClinicLimit(auth.session!) // ★ cwm-kioskpayout-20261010：店舖帳號只睇自己店（其他 = null 全部）
    const [rows, orphans, unpriced] = await Promise.all([staleCostCases(today, lim), orphanCostCases(lim), oldUnpricedCostCases(today, lim)])
    return jsonNoStore({ days: STALE_DAYS, rows, orphans, unpriced })
  })
}
