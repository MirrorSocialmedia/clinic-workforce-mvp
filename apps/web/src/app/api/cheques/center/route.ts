// ============================================================
// ★ cwm-chequeprint-20261005：GET /api/cheques/center?month=YYYY-MM&accountId= — 支票打印中心（只限老闆）
//   回傳：戶口、版面、三個分頁（員工／醫生／Lab）、本月呢個戶口已出嘅票（連作廢）
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { formatNo, isMonth, listLayouts, loadCenter } from '@/lib/cheque-print/server'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  return handleRoute('cheques-center', async () => {
    const sp = new URL(req.url).searchParams
    const month = sp.get('month')
    const accountId = sp.get('accountId') || ''
    if (!isMonth(month)) return jsonNoStore({ error: 'month 格式 YYYY-MM' }, { status: 400 })
    const account = await prisma.chequeAccount.findUnique({ where: { id: accountId } })
    if (!account) return jsonNoStore({ error: '搵唔到呢個戶口' }, { status: 404 })
    const layouts = await listLayouts()
    const layout = layouts.find(l => l.id === account.layoutId) ?? layouts[0]
    const [center, issued] = await Promise.all([
      loadCenter(month, accountId),
      prisma.cheque.findMany({ where: { accountId, periodMonth: month }, orderBy: { chequeNo: 'asc' } }),
    ])
    return jsonNoStore({
      account: {
        id: account.id, label: account.label, bankName: account.bankName, accountLast4: account.accountLast4,
        nextNo: account.nextNo, noWidth: account.noWidth, bookLastNo: account.bookLastNo,
        nextNoText: account.nextNo != null ? formatNo(account.nextNo, account.noWidth) : null,
        remaining: account.nextNo != null && account.bookLastNo != null ? Math.max(0, account.bookLastNo - account.nextNo + 1) : null,
      },
      layout,
      ...center,
      issued: issued.map(c => ({
        id: c.id, chequeNo: c.chequeNo, sourceType: c.sourceType, sourceId: c.sourceId, payeeName: c.payeeName,
        amount: Number(c.amount), chequeDate: c.chequeDate, status: c.status, confirmed: !!c.confirmedAt,
        voidReason: c.voidReason, createdAt: c.createdAt,
      })),
    })
  })
}
