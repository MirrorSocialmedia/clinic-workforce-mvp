export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { resolveProviderScheduleScope } from '@/lib/provider-scope'
import { findOverlappingLeave } from '@/lib/provider-leave-db'
import { lockKey, HttpError, toHttpResponse } from '@/lib/emp-lock'

export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error

  const startDate = req.nextUrl.searchParams.get('startDate')
  const endDate = req.nextUrl.searchParams.get('endDate')

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'startDate & endDate required' }, { status: 400 })
  }

  // ★ Scope guard: filter by clinic scope for non-OWNER
  const scope = await resolveProviderScheduleScope(auth.session!)
  const where: any = {
    startDate: { lte: hkDateEnd(endDate) },
    endDate: { gte: hkDateStart(startDate) },
  }
  if (scope !== null) {
    where.provider = {
      OR: [
        { clinics: { some: { clinicId: { in: scope } } } },
        { clinics: { none: {} } }, // ★ 未綁店的照顯示
      ],
    }
  }

  const leaves = await prisma.providerLeave.findMany({
    where,
    orderBy: [{ startDate: 'asc' }, { providerId: 'asc' }],
    include: { provider: { select: { id: true, name: true, shortName: true } } },
  })

  return jsonNoStore({ leaves })
}

export async function POST(req: NextRequest) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const { providerId, startDate, endDate, note } = body

  if (!providerId || !startDate || !endDate) {
    return NextResponse.json({ error: '醫生、開始日、結束日必填' }, { status: 400 })
  }

  const start = hkDateStart(startDate)
  const end = hkDateStart(endDate)

  if (end < start) {
    return NextResponse.json({ error: '結束日唔可以早過開始日' }, { status: 400 })
  }

  // ★ cwm-provroster S1-3 + B3（CHECK P-3）：同一醫生休假唔准重疊（之前會靜靜入兩條）。
  //   重疊檢查 + 寫入放同一 tx，用 advisory lock 按醫生串行 —— check-then-insert 原子化。
  try {
    const leave = await prisma.$transaction(async tx => {
      await lockKey(tx, `prov:${providerId}`)
      const overlap = await findOverlappingLeave(providerId, start, end, null, tx)
      if (overlap) throw new HttpError(409, overlap, { code: 'LEAVE_OVERLAP' })
      return tx.providerLeave.create({
        data: { providerId, startDate: start, endDate: end, note: note || null, createdBy: auth.session!.userId },
        include: { provider: { select: { id: true, name: true } } },
      })
    })

    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PROVIDER_LEAVE_SET',
        entity: 'ProviderLeave',
        entityId: leave.id,
        notes: `新增醫生休假：${leave.provider.name} ${startDate}–${endDate}`,
        afterJson: JSON.stringify({ providerId, startDate, endDate, note }),
      },
    }).catch(e => console.error('[provider-leaves] audit failed', e))

    return jsonNoStore({ leave })
  } catch (e: any) {
    const http = toHttpResponse(e)
    if (http) return http
    console.error('[provider-leaves] POST failed', e)
    return NextResponse.json({ error: '建立失敗' }, { status: 500 })
  }
}
