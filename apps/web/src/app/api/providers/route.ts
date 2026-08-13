export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error

  const includeInactive = req.nextUrl.searchParams.get('includeInactive') === '1'
  const providers = await prisma.provider.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      clinics: { select: { clinicId: true } },
    },
  })
  // Map to flat clinicIds for frontend
  const result = providers.map(p => ({
    ...p,
    clinicIds: p.clinics.map(c => c.clinicId),
  }))
  // Remove nested clinics from output
  const output = result.map(({ clinics, ...rest }) => rest)
  return jsonNoStore({ providers: output })
}

export async function POST(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const { name, shortName, phone, color, apricotId, companyId, sortOrder, clinicIds } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name 必填' }, { status: 400 })
  }

  // ★ D4: Validate clinicIds exist before creating
  if (Array.isArray(clinicIds) && clinicIds.length) {
    const existingClinics = await prisma.clinic.findMany({
      where: { id: { in: clinicIds } },
      select: { id: true },
    })
    const validIds = new Set(existingClinics.map((c: any) => c.id))
    const invalidIds = clinicIds.filter((cid: string) => !validIds.has(cid))
    if (invalidIds.length) {
      return NextResponse.json(
        { error: `無效的診所 ID：${invalidIds.join(', ')}` },
        { status: 400 }
      )
    }
  }

  try {
    const provider = await prisma.$transaction(async (tx) => {
      const p = await tx.provider.create({
        data: {
          name: name.trim(),
          shortName: shortName?.trim() || null,
          phone: phone?.trim() || null,
          color,
          apricotId: apricotId || null,
          companyId: companyId || null,
          sortOrder: sortOrder ?? 0,
        },
      })

      if (Array.isArray(clinicIds) && clinicIds.length) {
        await tx.providerClinic.createMany({
          data: clinicIds.map((cid: string) => ({ providerId: p.id, clinicId: cid })),
          skipDuplicates: true,
        })
      }

      return p
    })

    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PROVIDER_CREATE',
        entity: 'Provider',
        entityId: provider.id,
        notes: `新增醫生：${provider.name}`,
        afterJson: JSON.stringify({ id: provider.id, name: provider.name }),
      },
    }).catch(e => console.error('[providers] audit failed', e))

    // Return with clinicIds
    const withClinics = await prisma.provider.findUnique({
      where: { id: provider.id },
      include: { clinics: { select: { clinicId: true } } },
    })
    return jsonNoStore({ provider: { ...withClinics!, clinicIds: withClinics!.clinics.map(c => c.clinicId) } })
  } catch (e: any) {
    console.error('[providers] POST failed', e)
    if (e?.code === 'P2002') {
      return NextResponse.json(
        { error: `Apricot ID「${apricotId}」已經綁咗另一位醫生` },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: '建立失敗' }, { status: 500 })
  }
}
