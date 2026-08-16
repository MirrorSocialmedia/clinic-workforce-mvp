/**
 * GET /api/provider-referrals — List provider referrals (OWNER / provider_payout)
 * POST /api/provider-referrals — Create provider referral (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { jsonNoStore } from '@/lib/api-response'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const fromProviderId = searchParams.get('fromProviderId')
  const periodMonth = searchParams.get('periodMonth')

  const where: any = {}
  if (fromProviderId) where.fromProviderId = fromProviderId
  if (periodMonth) where.periodMonth = periodMonth

  const referrals = await prisma.providerReferral.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  return jsonNoStore({
    referrals: referrals.map(r => ({
      ...r,
      unitPrice: Number(r.unitPrice),
      refPercent: Number(r.refPercent),
      amount: Number(r.amount),
    })),
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({}))
  const {
    fromProviderId,
    toProviderId,
    billExtId,
    billCode,
    billItemEleId,
    itemDes,
    unitPrice,
    qty,
    refPercent,
    periodMonth,
    note,
  } = body

  if (!fromProviderId || !billExtId || !billItemEleId || !itemDes || !unitPrice || !periodMonth) {
    return NextResponse.json(
      { error: 'fromProviderId, billExtId, billItemEleId, itemDes, unitPrice, periodMonth required' },
      { status: 400 },
    )
  }

  const refPercentNum = refPercent ?? 2
  const qtyNum = qty ?? 1
  const amount = Number(((Number(unitPrice) * qtyNum * refPercentNum / 100).toFixed(2)))

  // ★ Resolve clinicId from bill — hard gate: 解唔到就 400
  const bill = await prisma.apricotBill.findUnique({
    where: { extId: billExtId },
    select: { clinicExtId: true },
  })
  if (!bill) {
    return NextResponse.json(
      { error: '帳單未同步落本地，請先同步該月份' },
      { status: 400 },
    )
  }
  const clinic = await prisma.clinic.findFirst({
    where: { apricotClinicId: bill.clinicExtId },
    select: { id: true, name: true },
  })
  if (!clinic) {
    return NextResponse.json(
      { error: `帳單所屬診所（Apricot ID ${bill.clinicExtId}）未對應，請去診所管理設定` },
      { status: 400 },
    )
  }
  const clinicId = clinic.id

  // Check if already locked — clinicId is guaranteed non-null by hard gate above
  const existingRun = await prisma.payoutRun.findFirst({
    where: {
      providerId: fromProviderId,
      clinicId,
      periodMonth,
      status: 'LOCKED',
    },
  })
  if (existingRun) {
    return NextResponse.json(
      { error: `該月已出月結 (${existingRun.periodMonth})，無法新增轉介` },
      { status: 409 },
    )
  }

  const referral = await prisma.providerReferral.create({
    data: {
      fromProviderId,
      toProviderId: toProviderId || null,
      clinicId,
      billExtId,
      billCode: billCode || '',
      billItemEleId,
      itemDes,
      unitPrice: Number(unitPrice),
      qty: qtyNum,
      refPercent: refPercentNum,
      amount,
      periodMonth,
      note: note || null,
      createdBy: auth.session!.userId,
    },
  })

  // Audit
  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'REFERRAL_CREATE',
      entity: 'ProviderReferral',
      entityId: referral.id,
      notes: `新增轉介：${itemDes} ${periodMonth} $${amount}`,
      afterJson: JSON.stringify({ fromProviderId, itemDes, periodMonth, amount }),
    },
  }).catch((e: any) => console.error('[provider-referrals] audit failed', e))

  return NextResponse.json({
    referral: {
      ...referral,
      unitPrice: Number(referral.unitPrice),
      refPercent: Number(referral.refPercent),
      amount: Number(referral.amount),
    },
  }, { status: 201 })
}
