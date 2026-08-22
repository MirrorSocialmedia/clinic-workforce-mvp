export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { resolveProviderScheduleScope, inScope } from '@/lib/provider-scope'

// ============================================================
// 醫生當值表「每週固定 pattern」（trace: cw-patwl-20260822-a1）
//
// GET /api/provider-patterns?clinicId=<id>
//   → 該店全部 pattern（weekly；一醫生一店一週期日一格）
// PUT /api/provider-patterns { providerId, clinicId, weekday, slot }
//   slot = 'FULL'|'AM'|'PM' → upsert；slot = null → 刪走該格
//
// ★ RBAC：KIOSK 只准 GET（打卡屏唔應該改當值表）—— 寫入 OWNER/MANAGER。
// ★ 診所 scope：照 provider-shifts 個做法（MANAGER 收窄到主屬店）。
// ============================================================

const VALID_SLOTS = ['FULL', 'AM', 'PM']

export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error

  const clinicId = req.nextUrl.searchParams.get('clinicId')
  if (!clinicId) {
    return NextResponse.json({ error: 'clinicId 必填' }, { status: 400 })
  }

  const scope = await resolveProviderScheduleScope(auth.session!)
  if (!inScope(scope, clinicId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const patterns = await prisma.providerWeeklyPattern.findMany({
      where: { clinicId },
      select: { providerId: true, weekday: true, slot: true, updatedAt: true },
      orderBy: [{ weekday: 'asc' }, { providerId: 'asc' }],
    })
    return jsonNoStore({ patterns, scope })
  } catch (e) {
    console.error('[provider-patterns] GET failed', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requirePerm(req, 'provider_schedule')
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const { providerId, clinicId } = body
  const weekday = body.weekday
  const slot = body.slot === undefined ? null : body.slot

  if (!providerId || !clinicId) {
    return NextResponse.json({ error: 'providerId / clinicId 必填' }, { status: 400 })
  }
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return NextResponse.json({ error: 'weekday 要 0-6' }, { status: 400 })
  }
  if (slot != null && !VALID_SLOTS.includes(String(slot))) {
    return NextResponse.json({ error: 'slot 要 FULL/AM/PM' }, { status: 400 })
  }

  // ★ 診所 scope —— 照 provider-shifts 個做法（MANAGER 改其他店 → 403，驗收 #8）
  const scope = await resolveProviderScheduleScope(auth.session!)
  if (!inScope(scope, clinicId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { id: true },
  })
  if (!provider) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  }

  try {
    if (slot == null) {
      await prisma.providerWeeklyPattern.deleteMany({ where: { providerId, clinicId, weekday } })
      return jsonNoStore({ ok: true, slot: null })
    }
    const saved = await prisma.providerWeeklyPattern.upsert({
      where: { providerId_clinicId_weekday: { providerId, clinicId, weekday } },
      update: { slot: String(slot), updatedBy: auth.session!.userId },
      create: { providerId, clinicId, weekday, slot: String(slot), updatedBy: auth.session!.userId },
      select: { slot: true },
    })
    return jsonNoStore({ ok: true, slot: saved.slot })
  } catch (e) {
    console.error('[provider-patterns] PUT failed', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
