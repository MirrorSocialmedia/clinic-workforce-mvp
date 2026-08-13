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
    orderBy: { periodMonth: 'desc' },
  })

  return NextResponse.json({
    subsidies: subsidies.map(s => ({
      ...s,
      listPrice: Number(s.listPrice),
      actualPrice: Number(s.actualPrice),
      splitPercent: Number(s.splitPercent),
      amount: Number(s.amount),
    })),
  })
}
