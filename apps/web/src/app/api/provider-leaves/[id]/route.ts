export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { resolveProviderScheduleScope } from '@/lib/provider-scope'
import { toHKDateStr } from '@/lib/hk-date'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error

  const { id } = await params

  try {
    const leave = await prisma.providerLeave.findUnique({
      where: { id },
      include: { provider: { select: { name: true, clinics: { select: { clinicId: true } } } } },
    })
    if (!leave) {
      return NextResponse.json({ error: '休假記錄不存在' }, { status: 404 })
    }

    if (auth.session!.role !== 'OWNER') { // ROLE-OK: OWNER 全權刪除；其他角色落 scope 檢查，唔係權限 gate
      const scope = await resolveProviderScheduleScope(auth.session!)
      const bound = leave.provider.clinics.map(c => c.clinicId)
      if (scope !== null && bound.length > 0 && !bound.some(c => scope.includes(c))) {
        return NextResponse.json({ error: '無權刪除此醫生的休假' }, { status: 403 })
      }
    }

    await prisma.providerLeave.delete({ where: { id } })

    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PROVIDER_LEAVE_DELETE',
        entity: 'ProviderLeave',
        entityId: id,
        notes: `刪除醫生休假：${leave.provider.name} ${toHKDateStr(leave.startDate)}–${toHKDateStr(leave.endDate)}${leave.note ? `（${leave.note}）` : ''}`,
        beforeJson: JSON.stringify(leave),
      },
    }).catch(e => console.error('[provider-leaves] audit failed', e))

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[provider-leaves] DELETE failed', e)
    if (e?.code === 'P2025') return NextResponse.json({ error: '不存在' }, { status: 404 })
    return NextResponse.json({ error: '刪除失敗' }, { status: 500 })
  }
}
