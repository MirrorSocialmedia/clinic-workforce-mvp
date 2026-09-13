export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { findDuplicateProviderAccounts } from '@/lib/apricot-accounts'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error

  const { id } = await params
  const body = await req.json().catch(() => ({} as any))
  const { name, shortName, phone, color, apricotAccounts, apricotUserId, companyId, sortOrder, isActive, clinicIds, showInCostEntry } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name 必填' }, { status: 400 })
  }

  // ★ F 章：apricotAccounts = [{ apricotId, name? }]（多帳號，set semantics：傳咗就係全量替換）
  const accounts: Array<{ apricotId: string; name?: string }> | undefined = Array.isArray(apricotAccounts)
    ? apricotAccounts.filter((a: any) => a && typeof a.apricotId === 'string' && a.apricotId.trim()) // ApricotPractitioner 帳號輸入
      .map((a: any) => ({ apricotId: a.apricotId.trim(), name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : undefined })) // ApricotPractitioner 帳號輸入
    : undefined
  // 重複 apricotId 守衛（排除自己：自己已綁嘅帳號唔算重複）
  if (accounts !== undefined) {
    const dup = await findDuplicateProviderAccounts(prisma, accounts, id)
    if (dup) {
      return NextResponse.json({ error: dup }, { status: 409 })
    }
  }

  // ★ D4: Validate clinicIds exist before updating
  if (clinicIds !== undefined && Array.isArray(clinicIds) && clinicIds.length) {
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
      const p = await tx.provider.update({
        where: { id },
        data: {
          name: name.trim(),
          shortName: shortName?.trim() || null,
          phone: phone?.trim() || null,
          color,
          ...(apricotUserId !== undefined && { apricotUserId: apricotUserId?.trim() || null }),
          companyId: companyId || null,
          sortOrder: sortOrder ?? 0,
          ...(isActive !== undefined && { isActive }),
          // ★ cwm-costentry-20260827 §1：成本錄入顯示開關（唔傳 = 保留原值）
          ...(showInCostEntry !== undefined && { showInCostEntry: !!showInCostEntry }),
        },
      })

      // ★ F 章：Apricot 帳號 set semantics —— 傳咗 apricotAccounts 先理（全量替換），
      //   冇傳 = 唔郁帳號。name 缺省用醫生名。
      if (accounts !== undefined) {
        await tx.apricotPractitioner.deleteMany({
          where: { providerId: id, kind: 'PROVIDER', apricotId: { notIn: accounts.map(({ apricotId }) => apricotId) } },
        })
        for (const { apricotId, name: acctName } of accounts) {
          await tx.apricotPractitioner.upsert({
            where: { apricotId },
            create: { apricotId, name: acctName || name.trim(), kind: 'PROVIDER', providerId: id },
            update: { name: acctName || name.trim(), kind: 'PROVIDER', providerId: id },
          })
        }
      }

      // Set semantics: only update clinic bindings when clinicIds is explicitly provided
      if (clinicIds !== undefined) {
        await tx.providerClinic.deleteMany({ where: { providerId: id } })
        if (Array.isArray(clinicIds) && clinicIds.length) {
          await tx.providerClinic.createMany({
            data: clinicIds.map((cid: string) => ({ providerId: id, clinicId: cid })),
            skipDuplicates: true,
          })
        }
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

    // Return with clinicIds + apricotAccounts
    const withRelations = await prisma.provider.findUnique({
      where: { id },
      include: {
        clinics: { select: { clinicId: true } },
        apricotAccounts: { where: { kind: 'PROVIDER' }, select: { apricotId: true, name: true } },
      },
    })
    return NextResponse.json({
      provider: {
        ...withRelations!,
        clinicIds: withRelations!.clinics.map(c => c.clinicId),
        apricotAccounts: withRelations!.apricotAccounts.map(({ apricotId, name: acctName }) => ({ apricotId, name: acctName })),
        clinics: undefined,
      },
    })
  } catch (e: any) {
    console.error('[providers] PUT failed', e)
    if (e?.code === 'P2025') return NextResponse.json({ error: '醫生不存在' }, { status: 404 })
    // ★ F 章：P2002（apricotId unique）由前置 findDuplicateAccounts 攔咗；
    //   呢度只留 race-condition fallback（同 POST 一致訊息）
    if (e?.code === 'P2002') {
      return NextResponse.json(
        { error: 'Apricot ID 已經綁咗其他帳號（可能係同時編輯），請刷新重試' },
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
