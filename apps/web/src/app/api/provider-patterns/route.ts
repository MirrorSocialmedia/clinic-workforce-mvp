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

  // ★ cwm-provroster S4 + B2（CHECK P-2）：樂觀鎖 atomic —— 唔再「findUnique 攞 slot → JS 比較 → upsert/delete」
  //   （兩部機同時撳會互相蓋走）。前端帶 expected（佢畫面見到嘅 slot；null = 空白）：
  //   由空白變有值 → create 靠 unique 擋（P2002 = STALE）；由 A 變 B → 條件 updateMany(slot: expected)；
  //   清除 → deleteMany 帶 slot 條件。唔帶 expected = 舊 client，照舊直接寫。
  const hasExp = Object.prototype.hasOwnProperty.call(body, 'expected')
  const expected = (body.expected ?? null) as string | null

  // stale409 = 409 句 + re-query 最新 slot 交畀前端更新畫面
  const stale409 = () => prisma.providerWeeklyPattern
    .findUnique({ where: { providerId_clinicId_weekday: { providerId, clinicId, weekday } }, select: { slot: true } })
    .then(cur => NextResponse.json(
      { error: '呢格啱啱俾其他人改咗，畫面已更新，請再揀一次', code: 'STALE', current: cur?.slot ?? null },
      { status: 409 },
    ))

  try {
    if (slot == null) { // 清除
      const d = await prisma.providerWeeklyPattern.deleteMany({
        where: { providerId, clinicId, weekday, ...(hasExp && expected ? { slot: expected } : {}) },
      })
      if (hasExp && d.count !== 1) return await stale409()
      return jsonNoStore({ ok: true, slot: null })
    }
    if (hasExp && expected === null) { // 由空白變有值 → 靠 unique 擋
      const c = await prisma.providerWeeklyPattern.create({
        data: { providerId, clinicId, weekday, slot: String(slot), updatedBy: auth.session!.userId },
        select: { slot: true },
      })
      return jsonNoStore({ ok: true, slot: c.slot })
    }
    if (hasExp) { // 由 A 變 B → 條件更新
      const u = await prisma.providerWeeklyPattern.updateMany({
        where: { providerId, clinicId, weekday, slot: expected! },
        data: { slot: String(slot), updatedBy: auth.session!.userId },
      })
      if (u.count !== 1) return await stale409()
      return jsonNoStore({ ok: true, slot: String(slot) })
    }
    // 冇帶 expected（舊 client）→ 照舊 upsert
    const saved = await prisma.providerWeeklyPattern.upsert({
      where: { providerId_clinicId_weekday: { providerId, clinicId, weekday } },
      update: { slot: String(slot), updatedBy: auth.session!.userId },
      create: { providerId, clinicId, weekday, slot: String(slot), updatedBy: auth.session!.userId },
      select: { slot: true },
    })
    return jsonNoStore({ ok: true, slot: saved.slot })
  } catch (e: any) {
    if (e?.code === 'P2002') return await stale409()
    console.error('[provider-patterns] PUT failed', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
