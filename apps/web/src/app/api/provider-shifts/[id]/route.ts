export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { resolveProviderScheduleScope, inScope } from '@/lib/provider-scope'
import { toHKDateStr } from '@/lib/hk-date'

const HHMM = /^\d{2}:\d{2}$/
const SLOT_VALUES = ['FULL', 'AM', 'PM', 'OFF']

/**
 * ★ cwm-provroster S1-2：改單條醫生當值例外（原地 update，唔再「刪舊 → batch 新增」）。
 *   body: { start: 'HH:mm', end: 'HH:mm', slot: 'FULL'|'AM'|'PM'|'OFF'|null, note?: string|null,
 *           clinicId?: string, expectedUpdatedAt?: ISO }（S4-3 樂觀鎖）
 *   日期唔准改（改日期 = 刪 + 新增，由前端做）。
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error

  const { id } = await params
  const body = await req.json().catch(() => ({} as any))
  const start: string = body.start
  const end: string = body.end
  const slot: string | null = body.slot ? String(body.slot) : null
  const note: string | null = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null

  if (!HHMM.test(start ?? '') || !HHMM.test(end ?? '')) {
    return NextResponse.json({ error: '時間格式要 HH:mm' }, { status: 400 })
  }
  if (slot !== null && !SLOT_VALUES.includes(slot)) {
    return NextResponse.json({ error: 'slot 要 FULL / AM / PM / OFF' }, { status: 400 })
  }

  const scope = await resolveProviderScheduleScope(auth.session!)
  const target = await prisma.providerShift.findUnique({
    where: { id },
    select: { id: true, clinicId: true, providerId: true, date: true, startTime: true, endTime: true, slot: true, note: true, updatedAt: true },
  })
  if (!target) return NextResponse.json({ error: '當值記錄不存在（可能已被其他人刪除），請重新整理' }, { status: 404 })

  const clinicId: string = body.clinicId || target.clinicId
  if (!inScope(scope, target.clinicId) || !inScope(scope, clinicId)) {
    return NextResponse.json({ error: '無權修改此診所的當值' }, { status: 403 })
  }

  const dStr = toHKDateStr(target.date)
  const startTime = new Date(`${dStr}T${start}:00+08:00`)
  let endTime = new Date(`${dStr}T${end}:00+08:00`)
  if (endTime.getTime() <= startTime.getTime()) endTime = new Date(endTime.getTime() + 86400000) // 跨夜（同 batch 一致）

  try {
    // ★ cwm-provroster B1（CHECK P-1）：樂觀鎖 atomic —— 條件 updateMany + count，
    //   唔再「findUnique 攞 updatedAt → JS 比較 → update」兩步（真並發會互相蓋走）。
    const r = await prisma.providerShift.updateMany({
      where: { id, ...(body.expectedUpdatedAt ? { updatedAt: new Date(body.expectedUpdatedAt) } : {}) },
      data: { startTime, endTime, slot, note, clinicId },
    })
    if (r.count !== 1) {
      return NextResponse.json({ error: '呢條當值啱啱俾其他人改咗，畫面已更新，請再睇一次', code: 'STALE' }, { status: 409 })
    }
    const updated = await prisma.providerShift.findUnique({ where: { id } }) // 回 response 用
    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PROVIDER_SHIFT_UPDATE',
        entity: 'ProviderShift',
        entityId: id,
        notes: `修改醫生當值：${dStr} ${slot ?? '按時間'} ${start}–${end}${note ? `（${note}）` : ''}`,
        beforeJson: JSON.stringify({ clinicId: target.clinicId, startTime: target.startTime, endTime: target.endTime, slot: target.slot, note: target.note }),
        afterJson: JSON.stringify({ clinicId, startTime, endTime, slot, note }),
      },
    }).catch(e => console.error('[provider-shifts] audit failed', e))
    return NextResponse.json({ shift: updated })
  } catch (e: any) {
    if (e?.code === 'P2002') {
      return NextResponse.json({ error: '同一醫生當日已有另一條同一開始時間嘅當值' }, { status: 409 })
    }
    if (e?.code === 'P2025') return NextResponse.json({ error: '當值記錄不存在' }, { status: 404 })
    console.error('[provider-shifts] PATCH failed', e)
    return NextResponse.json({ error: '儲存失敗' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error

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
