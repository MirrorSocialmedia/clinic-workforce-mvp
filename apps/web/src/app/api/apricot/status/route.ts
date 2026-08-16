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
      isSuperseded: false,
    },
    select: { methodNorm: true },
    distinct: ['methodNorm'],
  })

  // 3) needsReview 數
  const needsReviewCount = await prisma.paymentAllocation.count({
    where: { needsReview: true, isVoid: false, isSuperseded: false },
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

  // 7) needsReview 明細
  const reviewDetails = await prisma.paymentAllocation.findMany({
    where: { needsReview: true, isVoid: false, isSuperseded: false },
    select: {
      paymentExtId: true, billExtId: true, providerExtId: true,
      clinicExtId: true, paidAt: true, methodNorm: true, amount: true,
    },
    orderBy: { paidAt: 'desc' },
    take: 50,
  })

  // 補 billCode + provider/clinic name + methodRaw（批量查詢）
  const reviewBillExtIds = [...new Set(reviewDetails.map(r => r.billExtId))]
  const reviewPaymentExtIds = [...new Set(reviewDetails.map(r => r.paymentExtId))]
  const [reviewBills, reviewProviders, reviewClinics, reviewPayments] = await Promise.all([
    prisma.apricotBill.findMany({
      where: { extId: { in: reviewBillExtIds } },
      select: { extId: true, code: true, billTime: true },
    }),
    prisma.provider.findMany({
      where: { apricotId: { in: reviewDetails.map(r => r.providerExtId).filter(Boolean) as string[] } },
      select: { apricotId: true, name: true },
    }),
    prisma.clinic.findMany({
      where: { apricotClinicId: { in: reviewDetails.map(r => r.clinicExtId).filter(Boolean) as string[] } },
      select: { apricotClinicId: true, name: true },
    }),
    // ★ 透過 paymentExtId → ApricotPayment → methods 取得 methodRaw
    prisma.apricotPayment.findMany({
      where: { extId: { in: reviewPaymentExtIds } },
      select: { extId: true, methods: { select: { methodNorm: true, methodRaw: true } } },
    }),
  ])

  const reviewBillMap = new Map(reviewBills.map(b => [b.extId, b]))
  const reviewProviderMap = new Map(reviewProviders.map(p => [p.apricotId, p.name]))
  const reviewClinicMap = new Map(reviewClinics.map(c => [c.apricotClinicId, c.name]))
  // ★ methodRaw lookup: key = paymentExtId + '|' + methodNorm
  const reviewMethodRawMap = new Map<string, string>()
  for (const p of reviewPayments) {
    for (const m of p.methods) {
      reviewMethodRawMap.set(`${p.extId}|${m.methodNorm}`, m.methodRaw)
    }
  }

  const reviewDetailsEnriched = reviewDetails.map(r => ({
    paymentExtId: r.paymentExtId,
    billExtId: r.billExtId,
    providerExtId: r.providerExtId,
    clinicExtId: r.clinicExtId,
    paidAt: r.paidAt,
    methodNorm: r.methodNorm,
    amount: Number(r.amount),
    methodRaw: reviewMethodRawMap.get(`${r.paymentExtId}|${r.methodNorm}`) ?? null,
    billCode: reviewBillMap.get(r.billExtId)?.code ?? null,
    billTime: reviewBillMap.get(r.billExtId)?.billTime ?? null,
    providerName: r.providerExtId ? (reviewProviderMap.get(r.providerExtId) ?? null) : null,
    clinicName: reviewClinicMap.get(r.clinicExtId) ?? null,
  }))

  return jsonNoStore({
    lastSyncedAt: latestPayment?.syncedAt || null,
    unknownMethods: unknownMethods.map(m => m.methodNorm),
    needsReviewCount,
    reviewDetails: reviewDetailsEnriched,
    totalPayments,
    totalBills,
    perClinic,
  })
}
