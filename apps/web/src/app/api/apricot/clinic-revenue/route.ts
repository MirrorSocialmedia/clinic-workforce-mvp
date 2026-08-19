// ★ MD-AC3: 店鋪營收卡片
// GET /api/apricot/clinic-revenue?periodMonth=YYYY-MM
//
// 契約（拍板）：
//   - 營收 = allocation `amount`（原始金額，唔扣手續費）
//   - paymentCount = apricotPayment 真付款筆數（唔係 allocation 行數）
//   - 未綁 Apricot ID 嘅診所亦要回（UI 做虛線卡，唔好隱藏）
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { handleRoute } from '@/lib/api-guard'
import { jsonNoStore } from '@/lib/api-response'
import { prisma } from '@/lib/prisma'

/** 'YYYY-MM' → [月初 00:00 HK, 下月月初 00:00 HK) */
function monthBounds(periodMonth: string): [Date, Date] {
  const [y, m] = periodMonth.split('-').map(Number)
  const start = new Date(`${periodMonth}-01T00:00:00+08:00`)
  const next = m >= 12
    ? new Date(`${y + 1}-01-01T00:00:00+08:00`)
    : new Date(`${y}-${String(m + 1).padStart(2, '0')}-01T00:00:00+08:00`)
  return [start, next]
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, req.method, req.url)
  if (isAuthError(auth)) return auth.error

  return handleRoute('apricot/clinic-revenue', async () => {
    const periodMonth = req.nextUrl.searchParams.get('periodMonth') ?? ''
    if (!/^\d{4}-\d{2}$/.test(periodMonth)) {
      throw new Error('periodMonth (YYYY-MM) 必填')
    }
    const [monthStart, nextMonthStart] = monthBounds(periodMonth)

    // 全部診所（包括未綁）— 未綁嗰啲唔好隱藏
    const allClinics = await prisma.clinic.findMany({
      select: { id: true, name: true, shortName: true, apricotClinicId: true },
      orderBy: { name: 'asc' },
    })

    const clinics = await Promise.all(allClinics.map(async (c) => {
      // 未綁 Apricot ID：無數據可言
      if (!c.apricotClinicId) {
        return {
          clinicId: c.id,
          name: c.name,
          shortName: c.shortName,
          apricotClinicId: null as string | null,
          bound: false,
          revenue: 0,
          allocationRowCount: 0,
          paymentCount: 0,
          firstPaidAt: null as Date | null,
          lastPaidAt: null as Date | null,
          lastSyncedAt: null as Date | null,
          providerCount: 0,
          payoutRunCount: 0,
          hasData: false,
        }
      }

      const allocWhere = {
        clinicExtId: c.apricotClinicId,
        periodMonth,
        isVoid: false,
        isSuperseded: false,
        countAsIncome: true,
      }

      // 營收 = 原始金額（amount，唔扣手續費）+ allocation 行數 + 付款日期範圍
      const agg = await prisma.paymentAllocation.aggregate({
        where: allocWhere,
        _sum: { amount: true },
        _count: { _all: true },
        _min: { paidAt: true },
        _max: { paidAt: true },
      })

      // ★ 真付款筆數 — allocation 一行可能係一筆付款嘅分拆，兩者唔同
      const paymentCount = await prisma.apricotPayment.count({
        where: {
          clinicExtId: c.apricotClinicId,
          paidAt: { gte: monthStart, lt: nextMonthStart },
          isVoid: false,
        },
      })

      // 醫生位數 — 呢個月有收入 allocation 嘅唔同醫生
      const providers = await prisma.paymentAllocation.findMany({
        where: { ...allocWhere, providerExtId: { not: null } },
        select: { providerExtId: true },
        distinct: ['providerExtId'],
      })

      // 最後同步時間（全期，同 status route 一致）
      const syncAgg = await prisma.apricotPayment.aggregate({
        where: { clinicExtId: c.apricotClinicId },
        _max: { syncedAt: true },
      })

      // 已出月結 — 該店該月嘅 payout run 數（DRAFT + LOCKED 都計）
      const payoutRunCount = await prisma.payoutRun.count({
        where: { clinicId: c.id, periodMonth },
      })

      const allocationRowCount = agg._count._all
      // 「該月有無同步過」— 有付款或有 allocation 都算
      const hasData = paymentCount > 0 || allocationRowCount > 0

      return {
        clinicId: c.id,
        name: c.name,
        shortName: c.shortName,
        apricotClinicId: c.apricotClinicId,
        bound: true,
        revenue: Number(agg._sum.amount ?? 0),
        allocationRowCount,
        paymentCount,
        firstPaidAt: agg._min.paidAt ?? null,
        lastPaidAt: agg._max.paidAt ?? null,
        lastSyncedAt: syncAgg._max.syncedAt ?? null,
        providerCount: providers.length,
        payoutRunCount,
        hasData,
      }
    }))

    const bound = clinics.filter(c => c.bound)
    const unboundClinics = allClinics
      .filter(c => !c.apricotClinicId)
      .map(c => ({ id: c.id, name: c.name }))

    return jsonNoStore({
      periodMonth,
      // 合計只計綁咗嘅店；★ 唔顯示手續費
      totalRevenue: Number(bound.reduce((s, c) => s + c.revenue, 0).toFixed(2)),
      totalPayments: bound.reduce((s, c) => s + c.paymentCount, 0),
      unsyncedCount: bound.filter(c => !c.hasData).length,
      unboundClinics,
      clinics,
    })
  })
}
