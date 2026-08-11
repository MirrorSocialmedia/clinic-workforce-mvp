export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm } from '@/lib/require-auth'
import { resolveProviderScheduleScope, inScope } from '@/lib/provider-scope'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (auth.error) return auth.error

  const { id } = await params
  const scope = await resolveProviderScheduleScope(auth.session!)

  const target = await prisma.providerShift.findUnique({
    where: { id },
    select: { id: true, clinicId: true },
  })

  if (!target) return NextResponse.json({ error: '當值記錄不存在' }, { status: 404 })

  if (!inScope(scope, target.clinicId)) {
    return NextResponse.json({ error: '無權刪除此診所的當值' }, { status: 403 })
  }

  try {
    await prisma.providerShift.delete({ where: { id } })

    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PROVIDER_SHIFT_DELETE',
        entity: 'ProviderShift',
        entityId: id,
        notes: `刪除醫生當值: ${id}`,
      },
    }).catch(e => console.error('[provider-shifts] audit failed', e))

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[provider-shifts] DELETE failed', e)
    if (e?.code === 'P2025') return NextResponse.json({ error: '當值記錄不存在' }, { status: 404 })
    return NextResponse.json({ error: '刪除失敗' }, { status: 500 })
  }
}
