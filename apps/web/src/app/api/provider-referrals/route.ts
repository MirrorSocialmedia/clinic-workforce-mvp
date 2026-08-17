/**
 * GET /api/provider-referrals — List provider referrals (OWNER / provider_payout)
 * POST /api/provider-referrals — Create provider referral (OWNER / provider_payout)
 * MD-U: Supports draft referrals (status=DRAFT) without bill data
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
  const status = searchParams.get('status') // 'DRAFT' | 'CONFIRMED' | null

  const where: any = {}
  if (fromProviderId) where.fromProviderId = fromProviderId
  if (periodMonth) where.periodMonth = periodMonth
  if (status) where.status = status

  const referrals = await prisma.providerReferral.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  // ★ Y1: Bulk query clinics + bills for clinicName & billTime
  const clinicIds = [...new Set(referrals.map(r => r.clinicId).filter(Boolean))] as string[]
  const billExtIds = [...new Set(referrals.map(r => r.billExtId).filter(Boolean))] as string[]

  const [clinics, bills] = await Promise.all([
    clinicIds.length > 0
      ? prisma.clinic.findMany({ where: { id: { in: clinicIds } }, select: { id: true, name: true } })
      : [],
    billExtIds.length > 0
      ? prisma.apricotBill.findMany({ where: { extId: { in: billExtIds } }, select: { extId: true, billTime: true } })
      : [],
  ])

  const clinicMap = new Map(clinics.map(c => [c.id, c.name]))
  const billTimeMap = new Map(bills.map(b => [b.extId, b.billTime]))

  // Build provider map
  const providerIds = new Set<string>()
  referrals.forEach(r => {
    providerIds.add(r.fromProviderId)
    if (r.toProviderId) providerIds.add(r.toProviderId)
  })
  const providers = await prisma.provider.findMany({
    where: { id: { in: [...providerIds] } },
    select: { id: true, name: true },
  })
  const providerMap = new Map(providers.map(p => [p.id, p.name]))

  return jsonNoStore({
    referrals: referrals.map(r => ({
      ...r,
      unitPrice: r.unitPrice != null ? Number(r.unitPrice) : null,
      refPercent: Number(r.refPercent),
      amount: r.amount != null ? Number(r.amount) : null,
      fromProviderName: providerMap.get(r.fromProviderId) ?? null,
      toProviderName: r.toProviderId ? (providerMap.get(r.toProviderId) ?? null) : null,
      // ★ Y1: clinicName + billTime
      clinicName: r.clinicId
        ? (clinicMap.has(r.clinicId) ? clinicMap.get(r.clinicId) : '__DELETED_CLINIC__')
        : null,
      billTime: r.billExtId ? (billTimeMap.get(r.billExtId) ?? null) : null,
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
    patientNote,
    status,
  } = body

  // MD-U: Draft referrals don't need bill data
  const isDraft = status === 'DRAFT'

  if (!fromProviderId) {
    return NextResponse.json(
      { error: 'fromProviderId required' },
      { status: 400 },
    )
  }

  if (!isDraft && (!billExtId || !billItemEleId || !itemDes || !unitPrice || !periodMonth)) {
    return NextResponse.json(
      { error: 'billExtId, billItemEleId, itemDes, unitPrice, periodMonth required for CONFIRMED referrals' },
      { status: 400 },
    )
  }

  // For drafts, require periodMonth at minimum
  if (isDraft && !periodMonth) {
    return NextResponse.json(
      { error: 'periodMonth required' },
      { status: 400 },
    )
  }

  const refPercentNum = refPercent ?? 2
  const qtyNum = qty ?? 1

  // Calculate amount only for confirmed referrals
  let amount: number | null = null
  if (!isDraft) {
    amount = Number(((Number(unitPrice) * qtyNum * refPercentNum / 100).toFixed(2)))
  }

  // Resolve clinicId from bill (for confirmed referrals only)
  let clinicId: string | null = null
  if (!isDraft && billExtId) {
    const bill = await prisma.apricotBill.findUnique({
      where: { extId: billExtId },
      select: { clinicExtId: true },
    })
    if (bill) {
      const clinic = await prisma.clinic.findFirst({
        where: { apricotClinicId: bill.clinicExtId },
        select: { id: true },
      })
      if (clinic) clinicId = clinic.id
    }
  }

  // Check if month is locked (for confirmed referrals)
  if (!isDraft && clinicId && periodMonth) {
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
  }

  const referral = await prisma.providerReferral.create({
    data: {
      fromProviderId,
      toProviderId: toProviderId || null,
      clinicId,
      billExtId: billExtId || null,
      billCode: billCode || null,
      billItemEleId: billItemEleId || null,
      itemDes: itemDes || null,
      unitPrice: !isDraft ? Number(unitPrice) : null,
      qty: qtyNum,
      refPercent: refPercentNum,
      amount: amount != null ? amount : null,
      periodMonth,
      note: note || null,
      patientNote: patientNote || null,
      status: status || 'CONFIRMED',
      createdBy: auth.session!.userId,
    },
  })

  // Audit
  const actionLabel = isDraft ? 'DRAFT_REFERRAL_CREATE' : 'REFERRAL_CREATE'
  const auditNote = isDraft
    ? `新增草稿轉介：${patientNote || '未填寫'} ${periodMonth}`
    : `新增轉介：${itemDes} ${periodMonth} $${amount}`

  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: actionLabel,
      entity: 'ProviderReferral',
      entityId: referral.id,
      notes: auditNote,
      afterJson: JSON.stringify({ fromProviderId, itemDes: itemDes || patientNote, periodMonth, amount }),
    },
  }).catch((e: any) => console.error('[provider-referrals] audit failed', e))

  return NextResponse.json({
    referral: {
      ...referral,
      unitPrice: referral.unitPrice != null ? Number(referral.unitPrice) : null,
      refPercent: Number(referral.refPercent),
      amount: referral.amount != null ? Number(referral.amount) : null,
    },
  }, { status: 201 })
}
