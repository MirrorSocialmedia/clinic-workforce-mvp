import { NextRequest } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { withApricotLockRetry, searchBillsByPatient } from '@/lib/apricot/client'
import { sanitizeBill } from '@/lib/apricot/sanitize'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/cost-cases/bill-search — Search bills by patient
// Perm: cost_entry
// Query: ?patientExtId=&months=12
// ★ months default 12, max 24; existingCostCount from CostCase
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'cost_entry')
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const patientExtId = searchParams.get('patientExtId')
  const monthsRaw = searchParams.get('months')

  if (!patientExtId) {
    return jsonNoStore({ error: 'patientExtId required' }, { status: 400 })
  }

  const months = Math.min(24, Math.max(1, monthsRaw ? parseInt(monthsRaw, 10) : 12))

  try {
    const rawBills = await withApricotLockRetry(() => searchBillsByPatient(patientExtId, months))

    // Sanitize each bill + collect extIds for cost count lookup
    const bills = rawBills.map((b: any) => sanitizeBill(b))

    // Count existing CostCase records per bill
    const billExtIds = bills.map(b => b.id).filter(Boolean)
    let costCounts: Record<string, number> = {}
    if (billExtIds.length > 0) {
      const counts = await prisma.costCase.groupBy({
        by: ['billExtId'],
        where: { billExtId: { in: billExtIds }, status: { not: 'VOID' } },
        _count: true,
      })
      for (const c of counts) {
        if (c.billExtId) costCounts[c.billExtId] = c._count
      }
    }

    // Attach existingCostCount to each bill
    const billsWithCount = bills.map(b => ({
      ...b,
      existingCostCount: costCounts[b.id] ?? 0,
    }))

    return jsonNoStore({ bills: billsWithCount })
  } catch (e: any) {
    const msg = e.message || ''
    if (msg === 'APRICOT_BUSY') {
      return jsonNoStore({ error: 'Apricot 忙碌，請稍後重試' }, { status: 503 })
    }
    if (msg.startsWith('APRICOT_HTTP_')) {
      return jsonNoStore({ error: msg }, { status: 502 })
    }
    if (msg === 'APRICOT_AUTH_EXPIRED') {
      return jsonNoStore({ error: 'Apricot 憑證失效，需要重新授權' }, { status: 401 })
    }
    return jsonNoStore({ error: '搜尋帳單失敗' }, { status: 500 })
  }
}
