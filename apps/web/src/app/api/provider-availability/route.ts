export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { toHKDateStr, hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { addDaysStr } from '@/lib/apricot/sync-availability'
import { mergeBookings } from '@/lib/apricot/merge-bookings'
import { resolveProviderScheduleScope, inScope } from '@/lib/provider-scope'
import { expandLeavesToSet } from '@/lib/provider-leave'

// ============================================================
// GET /api/provider-availability?clinicId=<Clinic.id>&from=YYYY-MM-DD
// Spec: docs/specs/PROVIDER_AVAILABILITY_SPEC.md §5
//
// 滾動 7 日（from..from+6；拍板③ —— 參數叫 `from` 唔叫 weekStart）。
// ★ 權限：requirePerm('scheduling')（照 repo 現有 auth 模式）。
// ★ 診所 scope：照 provider-scope（MANAGER 收窄到主屬店，唔可以跨公司）。
// ★ booked 用掃描線合併（§5.2）—— count = 段內總預約筆數，唔係同時人數。
// ★ 🔴 只回傳時間/狀態 —— 零病人資料（ProviderBooking 表本身就冇病人欄）。
// ============================================================

const STALE_MS = 30 * 60 * 1000 // §7.3 #20：超過 30 分鐘變黃（stale）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 分鐘數（00:00 起）→ 'HH:mm' */
function minToHHMM(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error

  const sp = req.nextUrl.searchParams
  const clinicId = sp.get('clinicId')
  if (!clinicId) {
    return NextResponse.json({ error: 'clinicId 必填' }, { status: 400 })
  }

  const from = sp.get('from') ?? toHKDateStr(new Date()) // default = 今日（HK）
  if (!DATE_RE.test(from)) {
    return NextResponse.json({ error: 'from 必須係 YYYY-MM-DD（HK）' }, { status: 400 })
  }
  const to = addDaysStr(from, 6) // ★ 滾動 7 日

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, name: true },
  })
  if (!clinic) {
    return NextResponse.json({ error: 'Clinic not found' }, { status: 404 })
  }

  // ★ 診所 scope —— MANAGER 唔應該睇到其他公司（收窄到主屬店）
  const scope = await resolveProviderScheduleScope(auth.session!)
  if (!inScope(scope, clinic.id)) {
    return NextResponse.json({ error: '無權查看此診所' }, { status: 403 })
  }

  // 列出全部 active provider —— 無 row 嘅都列出（openSch/booked = []）
  const [providers, availRows, bookRows] = await Promise.all([
    prisma.provider.findMany({
      where: { isActive: true },
      select: { id: true, name: true, color: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.providerAvailability.findMany({
      where: { clinicId: clinic.id, date: { gte: from, lte: to } },
      select: { providerId: true, date: true, startTime: true, endTime: true, syncedAt: true },
    }),
    prisma.providerBooking.findMany({
      where: { clinicId: clinic.id, date: { gte: from, lte: to } },
      select: { providerId: true, date: true, startMin: true, endMin: true, syncedAt: true },
    }),
  ])

  // sync 新鮮度：回傳窗口內兩張表 max(syncedAt)（§5.3：取代 ApricotSession.lastSyncAt）
  let lastSyncAt: string | null = null
  for (const r of [...availRows, ...bookRows]) {
    const t = r.syncedAt.toISOString()
    if (lastSyncAt === null || t > lastSyncAt) lastSyncAt = t
  }
  const stale =
    lastSyncAt === null || Date.now() - new Date(lastSyncAt).getTime() > STALE_MS

  // ★ 醫生休假（cw-pta spec §4）：ProviderLeave 冇 clinicId = 跨店生效，唔使按診所過濾。
  // 窗口內有重疊嘅假先撈（同 provider-leaves GET 嘅 window 判斷一致）。
  const leaves = await prisma.providerLeave.findMany({
    where: {
      providerId: { in: providers.map(p => p.id) },
      startDate: { lte: hkDateEnd(to) },
      endDate: { gte: hkDateStart(from) },
    },
    select: { providerId: true, startDate: true, endDate: true },
  })
  // 展開成 `${providerId}:${YYYY-MM-DD}`（HK 日）Set（start..end 兩端包入）
  const leaveSet = expandLeavesToSet(leaves)
  const windowDates: string[] = []
  for (let i = 0; i < 7; i++) windowDates.push(addDaysStr(from, i))

  const availByProvider = new Map<string, typeof availRows>()
  for (const a of availRows) {
    const arr = availByProvider.get(a.providerId) ?? []
    arr.push(a)
    availByProvider.set(a.providerId, arr)
  }
  const bookByProvider = new Map<string, typeof bookRows>()
  for (const b of bookRows) {
    const arr = bookByProvider.get(b.providerId) ?? []
    arr.push(b)
    bookByProvider.set(b.providerId, arr)
  }

  const providersOut = providers.map((p) => {
    // 開診：ProviderAvailability 行（startTime/endTime 'HH:mm'），date → start 排序
    const openSch = (availByProvider.get(p.id) ?? [])
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
      .map((a) => ({ date: a.date, start: a.startTime, end: a.endTime }))

    // 預約：逐日掃描線合併（§5.2）
    const byDate = new Map<string, { startMin: number; endMin: number }[]>()
    for (const b of bookByProvider.get(p.id) ?? []) {
      const arr = byDate.get(b.date) ?? []
      arr.push({ startMin: b.startMin, endMin: b.endMin })
      byDate.set(b.date, arr)
    }
    const booked: { date: string; start: string; end: string; count: number }[] = []
    for (const [date, rows] of [...byDate.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      for (const seg of mergeBookings(rows)) {
        booked.push({ date, start: minToHHMM(seg.s), end: minToHHMM(seg.e), count: seg.count })
      }
    }

    return {
      id: p.id,
      name: p.name,
      color: p.color,
      openSch,
      booked,
      // ★ 當日窗口內有假嘅 HK 日（可能空）；
      //   onLeave/leaveConflict 由前端 buildDays 按日算（衝突 = 有假 + 該日有開診/預約）。
      //   providers 本來就列出全部 active provider（無 Apricot row 都喺）→
      //   放假但完全無開診嘅醫生唔會消失（spec §4.2 ★#15）。
      leaveDates: windowDates.filter(d => leaveSet.has(`${p.id}:${d}`)),
    }
  })

  return jsonNoStore({
    clinic: { id: clinic.id, name: clinic.name },
    from,
    to,
    sync: { lastSyncAt, stale },
    providers: providersOut,
  })
}
