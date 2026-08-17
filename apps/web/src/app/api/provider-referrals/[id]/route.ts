/**
 * PUT /api/provider-referrals/[id] — Update referral (OWNER / provider_payout)
 * DELETE /api/provider-referrals/[id] — Delete referral (OWNER / provider_payout)
 * // ownership-ok: provider_payout 權限限制
 * MD-U: Supports completing DRAFT → CONFIRMED with bill data
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error

  const referral = await prisma.providerReferral.findUnique({
    where: { id: params.id },
  })
  if (!referral) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Check if locked
  if (referral.lockedByRunId) {
    return NextResponse.json(
      { error: '該轉介已鎖定喺月結單中，無法修改' },
      { status: 409 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const {
    unitPrice, qty, refPercent, itemDes, note,
    // MD-U: Complete draft with bill data
    billExtId, billCode, billItemEleId, status, patientNote,
    periodMonth,
  } = body

  const refPercentNum = refPercent ?? Number(referral.refPercent)
  const qtyNum = qty ?? referral.qty
  const unitPriceNum = unitPrice != null ? Number(unitPrice) : Number(referral.unitPrice ?? 0)
  const amount = unitPrice != null || qty != null || refPercent != null
    ? Number(((unitPriceNum * qtyNum * refPercentNum / 100).toFixed(2)))
    : referral.amount

  // Resolve clinicId from bill if billExtId is provided
  let clinicId = referral.clinicId
  if (billExtId && !referral.clinicId) {
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

  // Derive periodMonth from bill if completing draft
  let finalPeriodMonth = periodMonth || referral.periodMonth
  if (billExtId && !periodMonth) {
    const bill = await prisma.apricotBill.findUnique({
      where: { extId: billExtId },
    })
    if (bill) {
      finalPeriodMonth = toHKDateStr(bill.billTime).slice(0, 7)
    }
  }

  const updateData: any = {}
  if (unitPrice != null) updateData.unitPrice = Number(unitPrice)
  if (qty != null) updateData.qty = qtyNum
  if (refPercent != null) updateData.refPercent = refPercentNum
  if (itemDes != null) updateData.itemDes = itemDes
  if (note != null) updateData.note = note
  if (amount !== referral.amount) updateData.amount = amount
  if (billExtId) updateData.billExtId = billExtId
  if (billCode) updateData.billCode = billCode
  if (billItemEleId) updateData.billItemEleId = billItemEleId
  if (clinicId) updateData.clinicId = clinicId
  if (status) updateData.status = status
  if (patientNote != null) updateData.patientNote = patientNote
  if (finalPeriodMonth && finalPeriodMonth !== referral.periodMonth) updateData.periodMonth = finalPeriodMonth

  const updated = await prisma.providerReferral.update({
    where: { id: params.id },
    data: updateData,
  })

  return NextResponse.json({
    referral: {
      ...updated,
      unitPrice: updated.unitPrice != null ? Number(updated.unitPrice) : null,
      refPercent: Number(updated.refPercent),
      amount: updated.amount != null ? Number(updated.amount) : null,
    },
  })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error

  const referral = await prisma.providerReferral.findUnique({
    where: { id: params.id },
  })
  if (!referral) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Check if locked
  if (referral.lockedByRunId) {
    return NextResponse.json(
      { error: '該轉介已鎖定喺月結單中，無法刪除' },
      { status: 409 },
    )
  }

  await prisma.providerReferral.delete({
    where: { id: params.id },
  })

  // Audit
  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'REFERRAL_DELETE',
      entity: 'ProviderReferral',
      entityId: params.id,
      notes: `刪除轉介：${referral.itemDes || referral.patientNote || '草稿'} ${referral.periodMonth}`,
    },
  }).catch((e: any) => console.error('[provider-referrals] delete audit failed', e))

  return NextResponse.json({ success: true })
}
