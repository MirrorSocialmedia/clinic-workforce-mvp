export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { resolveProviderScheduleScope } from '@/lib/provider-scope'
import { toHKDateStr, hkDateStart } from '@/lib/hk-date'
import { findOverlappingLeave } from '@/lib/provider-leave-db'
import { lockKey, HttpError, toHttpResponse } from '@/lib/emp-lock'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error
  // ★ V-2：KIOSK（前台 iPad）唔准改醫生固定表／休假 —— RBAC_MATRIX 只准 OWNER/MANAGER，
  //   但 requirePerm 只睇 perm（KIOSK 預設有 provider_schedule），所以要喺度擋
  if (auth.session.role === 'KIOSK') return NextResponse.json({ error: '前台帳戶唔可以修改醫生固定表／休假' }, { status: 403 })

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

/**
 * ★ cwm-provroster S1-3：修改醫生休假（日期／備註）。body: { startDate, endDate, note }
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error
  // ★ V-2：KIOSK（前台 iPad）唔准改醫生固定表／休假 —— RBAC_MATRIX 只准 OWNER/MANAGER，
  //   但 requirePerm 只睇 perm（KIOSK 預設有 provider_schedule），所以要喺度擋
  if (auth.session.role === 'KIOSK') return NextResponse.json({ error: '前台帳戶唔可以修改醫生固定表／休假' }, { status: 403 })

  const { id } = await params
  const body = await req.json().catch(() => ({} as any))
  const { startDate, endDate } = body
  const note: string | null = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null
  if (!startDate || !endDate) {
    return NextResponse.json({ error: '開始日、結束日必填' }, { status: 400 })
  }
  const start = hkDateStart(startDate)
  const end = hkDateStart(endDate)
  if (end < start) {
    return NextResponse.json({ error: '結束日唔可以早過開始日' }, { status: 400 })
  }

  const leave = await prisma.providerLeave.findUnique({
    where: { id },
    include: { provider: { select: { name: true, clinics: { select: { clinicId: true } } } } },
  })
  if (!leave) return NextResponse.json({ error: '休假記錄不存在（可能已被刪除），請重新整理' }, { status: 404 })

  if (auth.session!.role !== 'OWNER') { // ROLE-OK: 同 DELETE 一致 —— OWNER 全權；其他角色落 scope 檢查
    const scope = await resolveProviderScheduleScope(auth.session!)
    const bound = leave.provider.clinics.map(c => c.clinicId)
    if (scope !== null && bound.length > 0 && !bound.some(c => scope.includes(c))) {
      return NextResponse.json({ error: '無權修改此醫生的休假' }, { status: 403 })
    }
  }

  // ★ cwm-provroster S1-3 + B3（CHECK P-3）：重疊檢查 + 更新放同一 tx（advisory lock 按醫生串行）；
  //   excludeId 排除自己。
  try {
    const updated = await prisma.$transaction(async tx => {
      await lockKey(tx, `prov:${leave.providerId}`)
      const overlap = await findOverlappingLeave(leave.providerId, start, end, id, tx)
      if (overlap) throw new HttpError(409, overlap, { code: 'LEAVE_OVERLAP' })
      return tx.providerLeave.update({
        where: { id },
        data: { startDate: start, endDate: end, note },
      })
    })
    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PROVIDER_LEAVE_UPDATE',
        entity: 'ProviderLeave',
        entityId: id,
        notes: `修改醫生休假：${leave.provider.name} ${toHKDateStr(leave.startDate)}–${toHKDateStr(leave.endDate)} → ${startDate}–${endDate}`,
        beforeJson: JSON.stringify({ startDate: leave.startDate, endDate: leave.endDate, note: leave.note }),
        afterJson: JSON.stringify({ startDate, endDate, note }),
      },
    }).catch(e => console.error('[provider-leaves] audit failed', e))
    return NextResponse.json({ leave: updated })
  } catch (e: any) {
    const http = toHttpResponse(e)
    if (http) return http
    console.error('[provider-leaves] PATCH failed', e)
    if (e?.code === 'P2025') return NextResponse.json({ error: '休假記錄不存在' }, { status: 404 })
    return NextResponse.json({ error: '儲存失敗' }, { status: 500 })
  }
}
