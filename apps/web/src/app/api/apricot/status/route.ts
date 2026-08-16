export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

/** GET /api/apricot/status — 最後同步時間 / 未知方式 / needsReview 數 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, req.method, req.url)
  if (isAuthError(auth)) return auth.error

  // 1) 最後同步時間
  const latestPayment = await prisma.apricotPayment.findFirst({
    orderBy: { syncedAt: 'desc' },
    select: { syncedAt: true },
  })

  // 2) 未知付款方式 — 有 allocation 但 methodNorm 喺 PaymentMethodRule 入面搵唔到
  const unknownMethods = await prisma.paymentAllocation.findMany({
    where: {
      needsReview: true,
      isVoid: false,
    },
    select: { methodNorm: true },
    distinct: ['methodNorm'],
  })

  // 3) needsReview 數
  const needsReviewCount = await prisma.paymentAllocation.count({
    where: { needsReview: true, isVoid: false },
  })

  // 4) 總 payment 數
  const totalPayments = await prisma.apricotPayment.count()

  // 5) 總 bill 數
  const totalBills = await prisma.apricotBill.count()

  // 6) 逐診所摘要 (I3)
  const clinics = await prisma.clinic.findMany({
    where: { apricotClinicId: { not: null } },
    select: { id: true, name: true, apricotClinicId: true },
    orderBy: { id: 'asc' },
  })

  const perClinic = await Promise.all(clinics.map(async (c) => {
    const [cnt, latest] = await Promise.all([
      prisma.apricotPayment.count({ where: { clinicExtId: c.apricotClinicId! } }),
      prisma.apricotPayment.findFirst({
        where: { clinicExtId: c.apricotClinicId! },
        orderBy: { syncedAt: 'desc' },
        select: { syncedAt: true, paidAt: true },
      }),
    ])
    return {
      clinicId: c.id,
      name: c.name,
      payments: cnt,
      lastSyncedAt: latest?.syncedAt ?? null,
      latestPaidAt: latest?.paidAt ?? null,
    }
  }))

  return jsonNoStore({
    lastSyncedAt: latestPayment?.syncedAt || null,
    unknownMethods: unknownMethods.map(m => m.methodNorm),
    needsReviewCount,
    totalPayments,
    totalBills,
    perClinic,
  })
}
