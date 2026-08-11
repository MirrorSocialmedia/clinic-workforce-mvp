export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (auth.error) return auth.error

  const providers = await prisma.provider.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true, name: true, shortName: true, phone: true,
      color: true, apricotId: true, companyId: true,
      isActive: true, sortOrder: true, createdAt: true, updatedAt: true,
    },
  })
  return jsonNoStore({ providers })
}

export async function POST(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (auth.error) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const { name, shortName, phone, color, apricotId, companyId, sortOrder } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name 必填' }, { status: 400 })
  }

  try {
    const provider = await prisma.provider.create({
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

    return jsonNoStore({ provider })
  } catch (e: any) {
    console.error('[providers] POST failed', e)
    return NextResponse.json({ error: '建立失敗' }, { status: 500 })
  }
}
