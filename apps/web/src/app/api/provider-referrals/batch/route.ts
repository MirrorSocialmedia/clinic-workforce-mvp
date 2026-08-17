/**
 * POST /api/provider-referrals/batch — Batch create referrals from bill items (OWNER / provider_payout)
 * Used for bill-linked referral entry (MD-U)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({}))
  const { fromProviderId, billExtId, refPercent, items, toProviderId } = body as any

  if (!fromProviderId || !billExtId || !items?.length) {
    return NextResponse.json(
      { error: 'fromProviderId, billExtId, items required' },
      { status: 400 },
    )
  }

  try {
    // Validate bill exists
    const bill = await prisma.apricotBill.findUnique({
      where: { extId: billExtId },
    })
    if (!bill) {
      return NextResponse.json(
        { error: '帳單未同步落本地' },
        { status: 404 },
      )
    }

    // Resolve clinic from bill
    let clinicId: string = ''
    if (bill.clinicExtId) {
      const clinic = await prisma.clinic.findFirst({
        where: { apricotClinicId: bill.clinicExtId },
        select: { id: true },
      })
      if (clinic) clinicId = clinic.id
    }

    // Validate quantities against bill items
    const billItems = await prisma.apricotBillItem.findMany({
      where: { billId: bill.id },
    })
    const billItemMap = new Map(billItems.map(i => [i.eleId, i]))

    for (const item of items) {
      const billItem = billItemMap.get(item.eleId)
      if (!billItem) {
        return NextResponse.json(
          { error: `項目 ${item.eleId} 唔存在` },
          { status: 404 },
        )
      }
      if (Number(item.qty) > billItem.qty) {
        return NextResponse.json(
          { error: `數量唔可以多過帳單嘅 ${billItem.qty}` },
          { status: 400 },
        )
      }
    }

    // Derive periodMonth from bill time
    const billDate = new Date(bill.billTime)
    const periodMonth = `${billDate.getFullYear()}-${String(billDate.getMonth() + 1).padStart(2, '0')}`

    // Transaction — 全入或全唔入
    const referrals = await prisma.$transaction(
      items.map((item: any) => {
        const unitPrice = Number(item.unitPrice)
        const qty = Number(item.qty)
        const refPct = Number(refPercent) ?? 2
        const amt = unitPrice * qty
        const amount = Math.round(amt * refPct / 100 / 100) * 100

        return prisma.providerReferral.create({
          data: {
            fromProviderId,
            toProviderId: toProviderId || null,
            billExtId,
            billCode: bill.code,
            billItemEleId: item.eleId,
            itemDes: item.itemDes ?? '',
            unitPrice: unitPrice,
            qty,
            refPercent: refPct,
            amount,
            clinicId: clinicId || null,
            periodMonth,
            status: 'CONFIRMED',
            createdBy: auth.session!.userId,
          },
        })
      }),
    )

    // Audit log
    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'REFERRAL_BATCH_CREATE',
        entity: 'ProviderReferral',
        entityId: billExtId,
        notes: `批次新增 ${referrals.length} 筆轉介：bill ${bill.code}`,
        afterJson: JSON.stringify({ fromProviderId, billExtId, count: referrals.length }),
      },
    }).catch((e: any) => console.error('[provider-referrals/batch] audit failed', e))

    return NextResponse.json(
      {
        referrals,
        count: referrals.length,
      },
      { status: 201 },
    )
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Batch failed' }, { status: 500 })
  }
}
