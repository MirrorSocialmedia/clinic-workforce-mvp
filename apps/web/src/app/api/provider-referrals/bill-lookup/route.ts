/**
 * GET /api/provider-referrals/bill-lookup — Lookup bill by code (OWNER / provider_payout)
 * Used for batch referral entry (MD-U)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')

  if (!code) {
    return NextResponse.json({ error: 'code required' }, { status: 400 })
  }

  try {
    const bill = await prisma.apricotBill.findFirst({
      where: { code },
      include: {
        items: {
          orderBy: { amt: 'desc' },
        },
      },
    })

    if (!bill) {
      return NextResponse.json(
        { error: '帳單未同步落本地，請先去 Apricot 同步該月份' },
        { status: 404 },
      )
    }

    if (bill.items.length === 0) {
      return NextResponse.json(
        { error: '該帳單冇項目資料，請重新同步' },
        { status: 404 },
      )
    }

    // Resolve provider from bill's providerExtId
    let providerName: string | null = null
    let providerId: string | null = null
    if (bill.providerExtId) {
      const provider = await prisma.provider.findUnique({
        where: { apricotId: bill.providerExtId },
      })
      if (provider) {
        providerName = provider.name
        providerId = provider.id
      }
    }

    // Resolve clinic from bill's clinicExtId
    let clinicName: string | null = null
    let clinicId: string | null = null
    if (bill.clinicExtId) {
      const clinic = await prisma.clinic.findFirst({
        where: { apricotClinicId: bill.clinicExtId },
      })
      if (clinic) {
        clinicName = clinic.name
        clinicId = clinic.id
      }
    }

    // Check which items already have referral records
    const existing = await prisma.providerReferral.findMany({
      where: { billExtId: bill.extId },
      select: { billItemEleId: true, fromProviderId: true },
    })
    const referred = new Set(existing.map(e => `${e.billItemEleId}|${e.fromProviderId}`))

    return NextResponse.json({
      billExtId: bill.extId,
      billCode: bill.code,
      billTime: bill.billTime,
      providerName,
      providerId,
      clinicName,
      clinicId,
      items: bill.items.map(i => ({
        eleId: i.eleId,
        feeItemDes: i.feeItemDes,
        qty: i.qty,
        unitPrice: Number(i.unitPrice),
        amt: Number(i.amt),
        alreadyReferred: referred.has(`${i.eleId}|${providerId}`),
      })),
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Lookup failed' }, { status: 500 })
  }
}
