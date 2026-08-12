export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error

  const { id } = await params
  const body = await req.json().catch(() => ({} as any))
  const { name, shortName, phone, color, apricotId, companyId, sortOrder, isActive, clinicIds } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name 必填' }, { status: 400 })
  }

  try {
    const provider = await prisma.$transaction(async (tx) => {
      const p = await tx.provider.update({
        where: { id },
        data: {
          name: name.trim(),
          shortName: shortName?.trim() || null,
          phone: phone?.trim() || null,
          color,
          apricotId: apricotId || null,
          companyId: companyId || null,
          sortOrder: sortOrder ?? 0,
          isActive: isActive !== undefined ? isActive : true,
        },
      })

      // Set semantics: delete old bindings, create new ones
      await tx.providerClinic.deleteMany({ where: { providerId: id } })
      if (Array.isArray(clinicIds) && clinicIds.length) {
        await tx.providerClinic.createMany({
          data: clinicIds.map((cid: string) => ({ providerId: id, clinicId: cid })),
          skipDuplicates: true,
        })
      }

      return p
    })

    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PROVIDER_UPDATE',
        entity: 'Provider',
        entityId: id,
        notes: `更新醫生：${provider.name}${isActive === false ? '（停用）' : ''}`,
        afterJson: JSON.stringify({ id, name: provider.name, isActive: provider.isActive }),
      },
    }).catch(e => console.error('[providers] audit failed', e))

    // Return with clinicIds
    const withClinics = await prisma.provider.findUnique({
      where: { id },
      include: { clinics: { select: { clinicId: true } } },
    })
    return NextResponse.json({ provider: { ...withClinics!, clinicIds: withClinics!.clinics.map(c => c.clinicId) } })
  } catch (e: any) {
    console.error('[providers] PUT failed', e)
    if (e?.code === 'P2025') return NextResponse.json({ error: '醫生不存在' }, { status: 404 })
    if (e?.code === 'P2002') {
      return NextResponse.json(
        { error: `Apricot ID「${apricotId}」已經綁咗另一位醫生` },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: '更新失敗' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error

  const { id } = await params
  // Soft delete — 改用 isActive: false
  try {
    await prisma.provider.update({
      where: { id },
      data: { isActive: false },
    })

    // Audit log for soft delete
    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PROVIDER_UPDATE',
        entity: 'Provider',
        entityId: id,
        notes: `停用醫生（DELETE）：${id}`,
        afterJson: JSON.stringify({ id, isActive: false }),
      },
    }).catch(e => console.error('[providers] audit failed', e))

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[providers] DELETE failed', e)
    if (e?.code === 'P2025') return NextResponse.json({ error: '醫生不存在' }, { status: 404 })
    return NextResponse.json({ error: '刪除失敗' }, { status: 500 })
  }
}
