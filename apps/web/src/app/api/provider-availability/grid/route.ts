export const dynamic = 'force-dynamic'
// ============================================================
// GET /api/provider-availability/grid?clinicId=<Clinic.id>&from=YYYY-MM-DD
// ★ providerslot-20260830 T2 — internal 四態格數據源（UI 專用）
//
// 點解唔用 external /api/external/v1/bookable-slots 做 UI 數據源：
//   - external 唔出 fragments（MD §一：碎片只係 UI 內部用）
//   - external 有 X-Api-Key + flowWindowDays clamp，UI 要 7 日全格
//
// ★ 權限：同 GET /api/provider-availability —
//   requireAnyPerm(['scheduling','provider_schedule']) + provider-scope 診所 scope。
// ★ 四態（MD §六）：返 T1 evaluateDay 原始 status（5 值）+ holds（HELD/IN_APRICOT
//   source/status/time）+ 15m 子格佔用 occ — view 層（provider-availability-view.ts）
//   映射成 UI 四態（實心綠/虛邊綠/橙邊/灰）。
// ★ 滾動 7 日（from..from+6）— 同現有 route 一致。
// 🔴 PII：ProviderHold.patientWaId/patientName 絕唔入 response —
//   holds 只有 s/e/src/st/at（時段 + 來源 + 狀態 + 建立時間）。
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAnyPerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { todayHK, hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { addDaysStr } from '@/lib/apricot/sync-availability'
import { resolveProviderScheduleScope, inScope } from '@/lib/provider-scope'
import { expandLeavesToSet } from '@/lib/provider-leave'
import {
  loadWindowData,
  evaluateProviderDay,
  sweepPastHoldsSafe,
  hkIsoNow,
  nowMinHk,
  type ClinicSlotConfig,
  type DayContext,
} from '@/lib/bookable-slots-service'
import { buildTimeline, minToHHmm } from '@/lib/bookable-slots'

const STALE_MS = 30 * 60 * 1000 // 同現有 GET（超過 30 分鐘變黃 stale）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ACTIVE_HOLD_STATUSES = ['HELD', 'IN_APRICOT'] as const

/** hold 元數據（tooltip 用 — 零 PII） */
interface HoldMeta {
  startMin: number
  endMin: number
  source: string
  status: string
  createdAt: Date
}

export async function GET(req: NextRequest) {
  const auth = await requireAnyPerm(req, ['scheduling', 'provider_schedule'])
  if (isAuthError(auth)) return auth.error

  const sp = req.nextUrl.searchParams
  const clinicId = sp.get('clinicId')
  if (!clinicId) {
    return NextResponse.json({ error: 'clinicId 必填' }, { status: 400 })
  }
  const from = sp.get('from') ?? todayHK()
  if (!DATE_RE.test(from)) {
    return NextResponse.json({ error: 'from 必須係 YYYY-MM-DD（HK）' }, { status: 400 })
  }
  const to = addDaysStr(from, 6) // 滾動 7 日

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: {
      id: true, name: true, shortName: true, apricotClinicId: true,
      capacityPerProvider: true, leadTimeMin: true, flowWindowDays: true, holdTimeoutHours: true,
    },
  })
  if (!clinic) {
    return NextResponse.json({ error: 'Clinic not found' }, { status: 404 })
  }

  // ★ 診所 scope — MANAGER 收窄到主屬店（同現有 GET）
  const scope = await resolveProviderScheduleScope(auth.session!)
  if (!inScope(scope, clinic.id)) {
    return NextResponse.json({ error: '無權查看此診所' }, { status: 403 })
  }

  // lazy sweep（fire-and-forget）— 讀前釋放已過時 HELD，確保四態（橙邊）貼地
  sweepPastHoldsSafe(clinic.id)

  const cfg: ClinicSlotConfig = {
    id: clinic.id,
    shortName: clinic.shortName,
    apricotClinicId: clinic.apricotClinicId,
    capacityPerProvider: clinic.capacityPerProvider,
    leadTimeMin: clinic.leadTimeMin,
    flowWindowDays: clinic.flowWindowDays,
    holdTimeoutHours: clinic.holdTimeoutHours,
  }

  // T1 一網打盡：openSch / bookings / holds / grid / onDuty（三層疊已剔 leave）
  const wd = await loadWindowData(cfg, from, to, null)

  // sync 新鮮度（同現有 GET 口徑：窗口內兩表 max(syncedAt)）
  const [availSync, bookSync] = await Promise.all([
    prisma.providerAvailability.aggregate({
      where: { clinicId: clinic.id, date: { gte: from, lte: to } },
      _max: { syncedAt: true },
    }),
    prisma.providerBooking.aggregate({
      where: { clinicId: clinic.id, date: { gte: from, lte: to } },
      _max: { syncedAt: true },
    }),
  ])
  const lastSyncAt = [availSync._max.syncedAt, bookSync._max.syncedAt]
    .filter((t): t is Date => t != null)
    .sort((a, b) => a.getTime() - b.getTime())
    .pop()?.toISOString() ?? null
  const stale = lastSyncAt === null || Date.now() - new Date(lastSyncAt).getTime() > STALE_MS

  // 醫生清單（該店 linked × active，sortOrder → name — 同現有 GET 排序一致）
  const linked = [...wd.providerName.keys()]
  const providers = await prisma.provider.findMany({
    where: { isActive: true, id: { in: linked } },
    select: { id: true, name: true, color: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })

  // 醫生休假（ProviderLeave 無 clinicId = 跨店生效；窗口重疊先撈 — 同現有 GET）
  const leaves = await prisma.providerLeave.findMany({
    where: {
      providerId: { in: providers.map(p => p.id) },
      startDate: { lte: hkDateEnd(to) },
      endDate: { gte: hkDateStart(from) },
    },
    select: { providerId: true, startDate: true, endDate: true },
  })
  const leaveSet = expandLeavesToSet(leaves)

  // 窗口預約總筆數（剔 -6 取消 — 同現有 GET weekBookings 口徑）— 篩選 chip 用
  const bookCounts = await prisma.providerBooking.groupBy({
    by: ['providerId'],
    where: { clinicId: clinic.id, date: { gte: from, lte: to }, status: { not: -6 } },
    _count: { _all: true },
  })
  const weekBookingsMap = new Map<string, number>(bookCounts.map(b => [b.providerId, b._count._all]))

  // hold 元數據（窗口內 active）— tooltip「hold 來源 + 時間」（零 PII）
  const holdRows = await prisma.providerHold.findMany({
    where: { clinicId: clinic.id, date: { gte: from, lte: to }, status: { in: [...ACTIVE_HOLD_STATUSES] } },
    select: { providerId: true, date: true, startMin: true, endMin: true, source: true, status: true, createdAt: true },
  })
  const holdMeta = new Map<string, HoldMeta[]>() // `${date}:${providerId}` → metas
  for (const h of holdRows) {
    const k = `${h.date}:${h.providerId}`
    const arr = holdMeta.get(k) ?? []
    arr.push(h)
    holdMeta.set(k, arr)
  }

  // dayFlags —「🚫 冇醫生當值」全灰判斷（★★#20 鐵律：hasPattern 保護）
  const patternCount = await prisma.providerWeeklyPattern.count({ where: { clinicId: clinic.id } })
  const hasPattern = patternCount > 0
  const dayFlags = wd.dates.map(d => ({
    date: d,
    onDutyCount: wd.onDuty.get(d)?.size ?? 0,
    hasPattern,
  }))

  const today = todayHK()
  const nowMin = nowMinHk()

  const providersOut = providers.map(p => {
    // 逐日：只出當值日（onDuty 三層疊已剔 leave）
    const days = wd.dates
      .filter(date => wd.onDuty.get(date)?.has(p.id))
      .map(date => {
        const openSch = wd.openSch.get(date)?.get(p.id) ?? null
        const bookings = wd.bookings.get(date)?.get(p.id) ?? []
        const holds = wd.holds.get(date)?.get(p.id) ?? []
        const apricotId = wd.providerApricotId.get(p.id) ?? null
        const ctx: DayContext = {
          capacity: clinic.capacityPerProvider,
          onLeave: false, // onDuty 已剔 leave（三層疊第 ③ 層 / fallback filter）
          minStartMin: date === today ? nowMin + clinic.leadTimeMin : null,
          openSch,
          bookings,
          holds,
          grid: apricotId ? (wd.grid.get(date)?.get(apricotId) ?? []) : [],
        }
        const ev = evaluateProviderDay(ctx, true)
        if (!ev) return { date, precise: false, bookCount: bookings.length, slots: [] } // 兩軌都冇數據 → 該日 0 格

        // 15m 子格佔用（精確軌先有）— mini seat 顯示用（bookings + holds）
        const precise = openSch != null
        let occT: number[] | null = null
        if (precise) {
          const bookT = buildTimeline(bookings)
          const holdT = buildTimeline(holds)
          occT = bookT.map((v, i) => v + holdT[i])
        }

        // 碎片 15m flag（[上 :00–:15, 下 :15–:30]）
        const frag: [number, number][] = Array.from({ length: 48 }, () => [0, 0] as [number, number])
        for (const f of ev.fragments) {
          const wi = Math.floor(f.startMin / 30)
          frag[wi][f.startMin % 30 === 0 ? 0 : 1] = 1
        }

        const metas = holdMeta.get(`${date}:${p.id}`) ?? []
        const slots = ev.slots.map(s => {
          const c0 = s.startMin / 15
          const overlap = metas.filter(h => h.startMin < s.endMin && h.endMin > s.startMin)
          return {
            i: s.startMin / 30,
            start: minToHHmm(s.startMin),
            end: minToHHmm(s.endMin),
            status: s.status,
            seatsFree: s.seatsFree,
            occ: precise && occT ? ([occT[c0], occT[c0 + 1]] as [number, number]) : null,
            frag: frag[s.startMin / 30],
            holds: overlap.map(h => ({
              s: minToHHmm(h.startMin),
              e: minToHHmm(h.endMin),
              src: h.source,
              st: h.status,
              at: h.createdAt.toISOString(),
            })),
          }
        })
        return { date, precise, bookCount: bookings.length, slots }
      })

    return {
      id: p.id,
      name: p.name,
      color: p.color,
      weekBookings: weekBookingsMap.get(p.id) ?? 0,
      leaveDates: wd.dates.filter(d => leaveSet.has(`${p.id}:${d}`)),
      days,
    }
  })

  return jsonNoStore({
    clinic: { id: clinic.id, name: clinic.name },
    from,
    to,
    capacity: clinic.capacityPerProvider,
    leadTimeMin: clinic.leadTimeMin,
    generatedAt: hkIsoNow(),
    sync: { lastSyncAt, stale },
    dayFlags,
    providers: providersOut,
  })
}
