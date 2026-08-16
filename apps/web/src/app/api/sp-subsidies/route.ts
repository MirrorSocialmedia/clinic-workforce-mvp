/**
 * GET /api/sp-subsidies — List SP subsidies (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const providerId = searchParams.get('providerId')
  const periodMonth = searchParams.get('periodMonth')
  const source = searchParams.get('source')

  const where: any = {}
  if (providerId) where.providerId = providerId
  if (periodMonth) where.periodMonth = periodMonth
  if (source) where.source = source

  const subsidies = await prisma.spSubsidy.findMany({
    where,
  })

  // 批量補齊關聯（Promise.all + Map）
  const billExtIds = [...new Set(subsidies.map(s => s.billExtId).filter(Boolean))]
  const providerIds = [...new Set(subsidies.map(s => s.providerId))]
  const clinicIds = [...new Set(subsidies.map(s => s.clinicId).filter(Boolean))]

  const [bills, providers, clinics] = await Promise.all([
    prisma.apricotBill.findMany({
      where: { extId: { in: billExtIds as string[] } },
      select: { extId: true, code: true, billTime: true },
    }),
    prisma.provider.findMany({
      where: { id: { in: providerIds } },
      select: { id: true, name: true },
    }),
    prisma.clinic.findMany({
      where: { id: { in: clinicIds as string[] } },
      select: { id: true, name: true },
    }),
  ])

  const billMap = new Map(bills.map(b => [b.extId, b]))
  const providerMap = new Map(providers.map(p => [p.id, p.name]))
  const clinicMap = new Map(clinics.map(c => [c.id, c.name]))

  const enriched = subsidies.map(s => ({
    ...s,
    listPrice: Number(s.listPrice),
    actualPrice: Number(s.actualPrice),
    splitPercent: Number(s.splitPercent),
    amount: Number(s.amount),
    providerName: providerMap.get(s.providerId) ?? null,
    clinicName: s.clinicId ? (clinicMap.get(s.clinicId) ?? null) : null,
    billCode: s.billExtId ? billMap.get(s.billExtId)?.code ?? null : null,
    billTime: s.billExtId ? billMap.get(s.billExtId)?.billTime ?? null : null,
  }))

  // S8: enrich 之後排序 — 預設：需覆核優先 → 日期（早→遲）→ billCode
  enriched.sort((a, b) => {
    if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1
    const ta = a.billTime ? new Date(a.billTime).getTime() : 0
    const tb = b.billTime ? new Date(b.billTime).getTime() : 0
    if (ta !== tb) return ta - tb
    return (a.billCode ?? '').localeCompare(b.billCode ?? '')
  })

  return NextResponse.json({ subsidies: enriched })
}
