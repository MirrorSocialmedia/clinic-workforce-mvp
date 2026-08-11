export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { hkDateStart, toHKDateStr } from '@/lib/hk-date'
import { resolveProviderScheduleScope, inScope } from '@/lib/provider-scope'

type Entry = { providerId: string; clinicId: string; date: string; start: string; end: string; note?: string }

export async function POST(req: NextRequest) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const entries: Entry[] = body.entries ?? []
  const repeatWeeks = Number(body.repeatWeeks ?? 1)
  const onConflict: 'skip' | 'overwrite' = body.onConflict === 'overwrite' ? 'overwrite' : 'skip'

  if (!entries.length) return NextResponse.json({ error: 'entries 不可為空' }, { status: 400 })
  if (!Number.isInteger(repeatWeeks) || repeatWeeks < 1 || repeatWeeks > 4) {
    return NextResponse.json({ error: 'repeatWeeks 必須係 1-4 嘅整數' }, { status: 400 })
  }
  if (entries.length * repeatWeeks > 500) {
    return NextResponse.json({ error: '一次過最多 500 條，請分批' }, { status: 400 })
  }

  // Validate time format
  for (const e of entries) {
    if (!/^\d{2}:\d{2}$/.test(e.start) || !/^\d{2}:\d{2}$/.test(e.end)) {
      return NextResponse.json({ error: `時間格式要 HH:mm：${e.start}-${e.end}` }, { status: 400 })
    }
  }

  const scope = await resolveProviderScheduleScope(auth.session!)

  // Validate providerId: all doctors must exist and be active
  const providerIds = [...new Set(entries.map(e => e.providerId))]
  const foundProviders = await prisma.provider.findMany({
    where: { id: { in: providerIds }, isActive: true },
    select: { id: true },
  })
  if (foundProviders.length !== providerIds.length) {
    return NextResponse.json({ error: '醫生不存在或已停用' }, { status: 400 })
  }

  // Validate clinicId for each entry
  for (const e of entries) {
    if (!e.clinicId) {
      return NextResponse.json({ error: 'clinicId 必填' }, { status: 400 })
    }
    if (!inScope(scope, e.clinicId)) {
      return NextResponse.json({ error: `無權為此診所排更：${e.clinicId}` }, { status: 403 })
    }
  }

  const rows: Array<{
    providerId: string; clinicId: string; date: Date;
    startTime: Date; endTime: Date; note: string | null
  }> = []

  for (const e of entries) {
    for (let w = 0; w < repeatWeeks; w++) {
      const day = new Date(hkDateStart(e.date).getTime() + w * 7 * 86400000)
      const dStr = toHKDateStr(day)
      const startTime = new Date(`${dStr}T${e.start}:00+08:00`)
      let endTime = new Date(`${dStr}T${e.end}:00+08:00`)
      if (endTime.getTime() <= startTime.getTime()) endTime = new Date(endTime.getTime() + 86400000) // 跨夜
      rows.push({ providerId: e.providerId, clinicId: e.clinicId, date: day, startTime, endTime, note: e.note ?? null })
    }
  }

  let created = 0, updated = 0, skipped = 0
  try {
    if (onConflict === 'skip') {
      // ★ Bulk insert with skipDuplicates — faster than per-row check
      const rowsWithAuth = rows.map(r => ({ ...r, createdBy: auth.session!.userId }))
      const r = await prisma.providerShift.createMany({
        data: rowsWithAuth,
        skipDuplicates: true,
      })
      created = r.count
      skipped = rows.length - r.count
    } else {
      // overwrite mode: per-row check + update
      for (const r of rows) {
        const key = { providerId_date_startTime: { providerId: r.providerId, date: r.date, startTime: r.startTime } }
        const existing = await prisma.providerShift.findUnique({ where: key })
        if (existing) {
          if (!inScope(scope, existing.clinicId)) { skipped++; continue }
          await prisma.providerShift.update({
            where: key,
            data: { clinicId: r.clinicId, endTime: r.endTime, note: r.note },
          })
          updated++
        } else {
          await prisma.providerShift.create({
            data: { ...r, createdBy: auth.session!.userId },
          })
          created++
        }
      }
    }
  } catch (e) {
    console.error('[provider-shifts/batch] failed', e)
    return NextResponse.json({ error: '寫入失敗', created, updated, skipped }, { status: 500 })
  }

  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'PROVIDER_SHIFT_BATCH',
      entity: 'ProviderShift',
      entityId: `batch_${Date.now()}`,
      notes: `批量排醫生當值：${entries.length} 條 × ${repeatWeeks} 週 → 新增 ${created} / 更新 ${updated} / 略過 ${skipped}`,
      afterJson: JSON.stringify({ entries: entries.length, repeatWeeks, created, updated, skipped, onConflict }),
    },
  }).catch(e => console.error('[provider-shifts/batch] audit failed', e))

  return NextResponse.json({ created, updated, skipped, total: rows.length })
}
