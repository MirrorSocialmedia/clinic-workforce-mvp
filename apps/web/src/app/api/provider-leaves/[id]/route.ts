export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error

  const { id } = await params

  try {
    const leave = await prisma.providerLeave.findUnique({ where: { id } })
    if (!leave) {
      return NextResponse.json({ error: '休假記錄不存在' }, { status: 404 })
    }

    // ★ Ownership guard: only creator can delete (ownership-ok)
    if (leave.createdBy !== auth.session!.userId) {
      return NextResponse.json({ error: '無權刪除（非建立者）' }, { status: 403 })
    }

    await prisma.providerLeave.delete({ where: { id } })

    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'DELETE',
        entity: 'ProviderLeave',
        entityId: id,
        notes: `刪除醫生休假：${id}`,
      },
    }).catch(e => console.error('[provider-leaves] audit failed', e))

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[provider-leaves] DELETE failed', e)
    if (e?.code === 'P2025') return NextResponse.json({ error: '不存在' }, { status: 404 })
    return NextResponse.json({ error: '刪除失敗' }, { status: 500 })
  }
}
