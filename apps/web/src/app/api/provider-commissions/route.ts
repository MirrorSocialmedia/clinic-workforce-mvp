export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'provider_payout')
  if (isAuthError(auth)) return auth.error

  const providerId = req.nextUrl.searchParams.get('providerId')

  const where: any = {}
  if (providerId) where.providerId = providerId

  const commissions = await prisma.providerCommission.findMany({
    where,
    orderBy: { effectiveFrom: 'desc' },
    include: { provider: { select: { id: true, name: true } } },
  })

  return jsonNoStore({ commissions })
}

export async function POST(req: NextRequest) {
  const auth = await requirePerm(req, 'provider_payout')
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const { providerId, clinicId, percent, basis, minGuarantee, effectiveFrom, effectiveTo, note } = body

  if (!providerId || percent == null || !basis || !effectiveFrom) {
    return NextResponse.json({ error: 'providerId, percent, basis, effectiveFrom required' }, { status: 400 })
  }

  const validBasis = ['GROSS', 'NET', 'CONSULT_ONLY']
  if (!validBasis.includes(basis)) {
    return NextResponse.json({ error: `basis must be one of: ${validBasis.join(', ')}` }, { status: 400 })
  }

  try {
    const commission = await prisma.providerCommission.create({
      data: {
        providerId,
        clinicId: clinicId || null,
        percent: new Prisma.Decimal(String(percent)),
        basis,
        minGuarantee: minGuarantee != null ? new Prisma.Decimal(String(minGuarantee)) : null,
        effectiveFrom: new Date(effectiveFrom),
        effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
        note: note || null,
        createdBy: auth.session!.userId,
      },
      include: { provider: { select: { id: true, name: true } } },
    })

    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PROVIDER_COMMISSION_SET',
        entity: 'ProviderCommission',
        entityId: commission.id,
        notes: `新增拆帳設定：${commission.provider.name} ${percent}% ${basis} 生效 ${effectiveFrom}`,
        afterJson: JSON.stringify({ providerId, percent, basis, effectiveFrom }),
      },
    }).catch(e => console.error('[provider-commissions] audit failed', e))

    return jsonNoStore({ commission })
  } catch (e: any) {
    console.error('[provider-commissions] POST failed', e)
    return NextResponse.json({ error: '建立失敗' }, { status: 500 })
  }
}
