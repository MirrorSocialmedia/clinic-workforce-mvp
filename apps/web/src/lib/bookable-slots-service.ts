// ============================================================
// 可約時段服務層 — providerslot-20260830 T1
//
// 數據源雙軌（MD §一 15 分鐘粒度 vs sync 窗口現實）：
//   - **精確軌**：ProviderAvailability（openSch raw）+ ProviderBooking
//     （raw 15m 預約，status∈{0,102}）→ evaluateDay 精確 15m 時間線。
//     覆蓋 = sync 過的日期（cron today..+6 每 15 分鐘；on-demand 週 sync）。
//   - **保守軌**：AvailabilityCache grid（30m 格 bookedCount，30 日覆蓋）
//     → W 同格精確匹配 + bookedCount ≤ capacity−1 先出。bookedCount ≥
//     capacity 寧缺勿濫（15m 詳情未 sync — MD 10:30 反例喺呢度會錯殺，
//     方向安全：唔會過賣，只係少出）。
//   - 兩軌都冇數據 → 該醫生該日 0 slots（closed 由 roster 決定，唔會假閉門）。
//
// 🔴 PII 鐵律（照 ProviderBooking / write-booking 現行模式）：
//   patientWaId/patientName 只入 ProviderHold（workforce 內部）+
//   Apricot payload（createBooking）— external response / audit / log 零回顯。
//   audit notes 一律只含 metadata（source/status/slot/providerId/reason）。
// ============================================================

import { basePrisma } from '@/lib/prisma'
import { ExternalApiError } from '@/lib/external-api'
import { resolveClinic } from '@/app/api/external/v1/bookings/guards'
import { todayHK, addDaysStr, hkDateStart, hkDateEnd, toHKDateStr } from '@/lib/hk-date'
import { expandLeavesToSet } from '@/lib/provider-leave'
import { resolveOnDuty } from '@/lib/provider-pattern'
import {
  evaluateDay,
  hhmmToMin,
  minToHHmm,
  type Interval,
  type SlotEval,
  type DayEval,
} from './bookable-slots'
import { signSlotKey, verifySlotKey } from './bookable-slot-key'
import {
  isApricotWriteEnabled,
  isNewPatientWriteEnabled,
  createBooking,
} from './apricot/write-booking'
import { Prisma } from '@prisma/client'

// ★ 佔用口徑同 sync-availability-cache.ts 一致（cwc-rdchain：0=已約 102=改期；
//   4=完成/-6=-7=取消一律唔計）
const ACTIVE_BOOKING_STATUSES = [0, 102] as const
const ACTIVE_HOLD_STATUSES = ['HELD', 'IN_APRICOT'] as const

// ─── 小工具 ──────────────────────────────────────────────────────────

/** 當前 HK wall-clock 分鐘數（HK 無 DST，shift 法安全） */
export function nowMinHk(now: Date = new Date()): number {
  const shifted = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong' }))
  return shifted.getHours() * 60 + shifted.getMinutes()
}

/** ISO 8601 帶 +08:00（MD 3.1 generatedAt 格式） */
export function hkIsoNow(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00')
}

/** 🔴 零 PII audit（fire-and-forget；notes 由 caller 保證唔含病人值） */
function auditHold(action: string, hold: { id: string; clinicId: string }, notes: Record<string, unknown>): void {
  basePrisma.auditLog
    .create({
      data: {
        actorId: null, // external key / system — 冇 workforce User
        action,
        entity: 'ProviderHold',
        entityId: hold.id,
        clinicId: hold.clinicId,
        notes: JSON.stringify(notes),
      },
    })
    .catch((err) => console.error('[bookable-slots] audit 寫入失敗', err))
}

export interface ClinicSlotConfig {
  id: string
  shortName: string | null
  apricotClinicId: string | null
  capacityPerProvider: number
  leadTimeMin: number
  flowWindowDays: number
  holdTimeoutHours: number
}

/** clinic 解析（shortName|cuid，照 bookings guards 語義）+ 4 設定欄 */
export async function resolveSlotClinic(clinicCode: string): Promise<ClinicSlotConfig> {
  const clinic = await resolveClinic(clinicCode)
  const cfg = await basePrisma.clinic.findUnique({
    where: { id: clinic.id },
    select: {
      id: true,
      shortName: true,
      apricotClinicId: true,
      capacityPerProvider: true,
      leadTimeMin: true,
      flowWindowDays: true,
      holdTimeoutHours: true,
    },
  })
  if (!cfg) throw new ExternalApiError(404, 'clinic not found', 'CLINIC_NOT_FOUND')
  return cfg
}

// ─── 窗口數據（GET 一次拎晒 — 3s SLA：逐 query 都係 indexed）──────────

export interface GridSlot {
  startMin: number
  endMin: number
  bookedCount: number
}

export interface WindowData {
  dates: string[]
  /** providerId → name */
  providerName: Map<string, string>
  /** providerId → apricotId（grid 軌 + Apricot write 用） */
  providerApricotId: Map<string, string | null>
  /** date → 當值 providerId 集（三層疊 或 fallback；已剔 leave） */
  onDuty: Map<string, Set<string>>
  /** date → providerId → openSch intervals（null = 未 sync） */
  openSch: Map<string, Map<string, Interval[]>>
  /** date → providerId → active bookings（raw 15m） */
  bookings: Map<string, Map<string, Interval[]>>
  /** date → providerId → active holds */
  holds: Map<string, Map<string, Interval[]>>
  /** date → providerApricotId → grid slots（AvailabilityCache，30m 格） */
  grid: Map<string, Map<string, GridSlot[]>>
}

export async function loadWindowData(
  clinic: ClinicSlotConfig,
  from: string,
  to: string,
  providerId: string | null,
): Promise<WindowData> {
  const pFilter = providerId ? { providerId } : {}

  const [links, providers, patterns, shifts, leaves, availRows, bookRows, holdRows, cacheRows] =
    await Promise.all([
      basePrisma.providerClinic.findMany({ where: { clinicId: clinic.id }, select: { providerId: true } }),
      basePrisma.provider.findMany({
        where: { isActive: true, ...(providerId ? { id: providerId } : {}) },
        select: { id: true, name: true, apricotId: true },
      }),
      basePrisma.providerWeeklyPattern.findMany({
        where: { clinicId: clinic.id },
        select: { providerId: true, weekday: true, slot: true },
      }),
      basePrisma.providerShift.findMany({
        where: { clinicId: clinic.id, date: { gte: hkDateStart(from), lte: hkDateEnd(to) }, ...pFilter },
        select: { providerId: true, date: true, slot: true },
      }),
      basePrisma.providerLeave.findMany({
        where: {
          startDate: { lte: hkDateEnd(to) },
          endDate: { gte: hkDateStart(from) },
          ...(providerId ? { providerId } : {}),
        },
        select: { providerId: true, startDate: true, endDate: true },
      }),
      basePrisma.providerAvailability.findMany({
        where: { clinicId: clinic.id, date: { gte: from, lte: to }, ...pFilter },
        select: { providerId: true, date: true, startTime: true, endTime: true },
      }),
      basePrisma.providerBooking.findMany({
        where: { clinicId: clinic.id, date: { gte: from, lte: to }, status: { in: [...ACTIVE_BOOKING_STATUSES] }, ...pFilter },
        select: { providerId: true, date: true, startMin: true, endMin: true },
      }),
      basePrisma.providerHold.findMany({
        where: { clinicId: clinic.id, date: { gte: from, lte: to }, status: { in: [...ACTIVE_HOLD_STATUSES] }, ...pFilter },
        select: { providerId: true, date: true, startMin: true, endMin: true },
      }),
      basePrisma.availabilityCache.findMany({
        where: { clinicId: clinic.id, date: { gte: from, lte: to }, isOpen: true },
        select: { providerApricotId: true, date: true, startTime: true, endTime: true, bookedCount: true },
      }),
    ])

  // 醫院綁定 × active ×（providerId filter 已喺 query 層）
  const linked = new Set(links.map((l) => l.providerId))
  const providerName = new Map<string, string>()
  const providerApricotId = new Map<string, string | null>()
  for (const p of providers) {
    if (!linked.has(p.id)) continue
    providerName.set(p.id, p.name)
    providerApricotId.set(p.id, p.apricotId)
  }

  // 日期序列
  const dates: string[] = []
  let d = from
  while (d <= to) {
    dates.push(d)
    d = addDaysStr(d, 1)
  }

  // 三層疊（pattern → shift 例外 → leave）；★ iron law #20：冇 pattern
  // 唔准全灰 — fallback = 全部綁定 active provider（剔 leave）
  const leaveSet = expandLeavesToSet(leaves)
  const shiftsByDay = new Map<string, { providerId: string; date: string; slot: string | null }[]>()
  for (const s of shifts) {
    const key = toHKDateStr(s.date)
    const arr = shiftsByDay.get(key) ?? []
    arr.push({ providerId: s.providerId, date: key, slot: s.slot })
    shiftsByDay.set(key, arr)
  }
  const hasPattern = patterns.length > 0
  const onDuty = new Map<string, Set<string>>()
  for (const date of dates) {
    let pids: Set<string>
    if (hasPattern) {
      pids = new Set(resolveOnDuty(date, patterns, shiftsByDay.get(date) ?? [], leaveSet).keys())
    } else {
      pids = new Set(
        [...providerName.keys()].filter((pid) => !leaveSet.has(`${pid}:${date}`)),
      )
    }
    onDuty.set(date, pids)
  }

  // 分桶
  const openSch = new Map<string, Map<string, Interval[]>>()
  for (const a of availRows) {
    const byP = openSch.get(a.date) ?? new Map<string, Interval[]>()
    const arr = byP.get(a.providerId) ?? []
    const s = hhmmToMin(a.startTime)
    const e = hhmmToMin(a.endTime)
    if (e > s) arr.push({ startMin: s, endMin: e })
    byP.set(a.providerId, arr)
    openSch.set(a.date, byP)
  }
  const bookings = new Map<string, Map<string, Interval[]>>()
  for (const b of bookRows) {
    const byP = bookings.get(b.date) ?? new Map<string, Interval[]>()
    const arr = byP.get(b.providerId) ?? []
    arr.push({ startMin: b.startMin, endMin: b.endMin })
    byP.set(b.providerId, arr)
    bookings.set(b.date, byP)
  }
  const holds = new Map<string, Map<string, Interval[]>>()
  for (const h of holdRows) {
    const byP = holds.get(h.date) ?? new Map<string, Interval[]>()
    const arr = byP.get(h.providerId) ?? []
    arr.push({ startMin: h.startMin, endMin: h.endMin })
    byP.set(h.providerId, arr)
    holds.set(h.date, byP)
  }
  const grid = new Map<string, Map<string, GridSlot[]>>()
  for (const c of cacheRows) {
    const byP = grid.get(c.date) ?? new Map<string, GridSlot[]>()
    const arr = byP.get(c.providerApricotId) ?? []
    const s = hhmmToMin(c.startTime)
    const e = hhmmToMin(c.endTime)
    if (e > s) arr.push({ startMin: s, endMin: e, bookedCount: c.bookedCount })
    byP.set(c.providerApricotId, arr)
    grid.set(c.date, byP)
  }

  return { dates, providerName, providerApricotId, onDuty, openSch, bookings, holds, grid }
}

// ─── 雙軌評估 ─────────────────────────────────────────────────────────

export interface DayContext {
  capacity: number
  onLeave: boolean
  /** 今日 = nowMin + leadTimeMin；非今日 = null */
  minStartMin: number | null
  /** null = 該日 openSch 未 sync */
  openSch: Interval[] | null
  bookings: Interval[]
  holds: Interval[]
  /** AvailabilityCache grid（30m 格；[] = 冇） */
  grid: GridSlot[]
}

/**
 * 單日單醫生評估。精確軌（openSch 有）→ evaluateDay；保守軌（grid）→
 * 30m 格匹配 + bookedCount 上限檢查；都冇 → null（0 slots）。
 */
export function evaluateProviderDay(ctx: DayContext, includeFragments = false): DayEval | null {
  if (ctx.openSch) {
    return evaluateDay({
      capacity: ctx.capacity,
      onLeave: ctx.onLeave,
      minStartMin: ctx.minStartMin,
      openSch: ctx.openSch,
      bookings: ctx.bookings,
      holds: ctx.holds,
      includeFragments,
    })
  }
  if (ctx.grid.length > 0) return gridEval(ctx, includeFragments)
  return null
}

/**
 * 保守軌：W 必須同 grid 格【精確匹配】（同起同止 30m 格 — grid 由 openSch
 * 起點 30m 步進生成，匹配 = W 完全喺 openSch 內）。bookedCount ≥ capacity
 * 寧缺勿濫（15m 詳情未 sync；方向安全：唔會過賣）。seatsFree = capacity −
 * bookedCount（下界 — 15m 碎片可能令真實剩餘更多）。
 */
function gridEval(ctx: DayContext, includeFragments: boolean): DayEval {
  const slots: SlotEval[] = []
  for (let s = 0; s < 1440; s += 30) {
    const row = ctx.grid.find((g) => g.startMin === s && g.endMin === s + 30)
    if (!row) {
      slots.push({ startMin: s, endMin: s + 30, status: 'outside_open', maxBookings: 0, maxOccupancy: 0, seatsFree: 0 })
      continue
    }
    let status: SlotEval['status']
    if (ctx.onLeave) status = 'on_leave'
    else if (ctx.minStartMin !== null && s < ctx.minStartMin) status = 'lead_time'
    else if (row.bookedCount >= ctx.capacity) status = 'over_capacity'
    else status = 'offerable'
    slots.push({
      startMin: s,
      endMin: s + 30,
      status,
      maxBookings: row.bookedCount,
      maxOccupancy: row.bookedCount,
      seatsFree: status === 'offerable' ? ctx.capacity - row.bookedCount : 0,
    })
  }
  // grid 冇 15m 粒度 → 碎片無法可靠計算（UI 碎片視圖對同步過嘅日子先有意義）
  return { slots, offerable: slots.filter((s) => s.status === 'offerable'), fragments: [] }
}

/**
 * 逐日逐醫生 → GET response（MD 3.1 契約 shape；碎片唔入 payload）。
 */
export interface SlotOut {
  start: string
  end: string
  providerId: string
  providerName: string
  seatsFree: number
  /** cwi-capacity-20260904 B7（F2）：容量口徑 = 每醫生每時段 3 人，
   *  問診+覆診共享同一池（bookedCount 不分 visit 類型）。
   *  = capacity − booked（同 seatsFree；独立欄俾 W 候選 filter 讀，缺欄時 W 當 1 向後兼容） */
  remainingCapacity: number
  slotKey: string
}

export interface DayOut {
  date: string
  closed: boolean
  offerableCount: number
  slots: SlotOut[]
}

export function buildDays(
  clinic: ClinicSlotConfig,
  wd: WindowData,
  now = new Date(),
  includeFragments = false,
): DayOut[] {
  const today = todayHK()
  const nowMin = nowMinHk(now)
  const clinicCode = clinic.shortName ?? clinic.id

  return wd.dates.map((date) => {
    const pids = wd.onDuty.get(date) ?? new Set<string>()
    const closed = pids.size === 0
    const daySlots: SlotOut[] = []
    for (const pid of pids) {
      const apricotId = wd.providerApricotId.get(pid) ?? null
      const openSch = wd.openSch.get(date)?.get(pid) ?? null
      const ctx: DayContext = {
        capacity: clinic.capacityPerProvider,
        onLeave: false, // onDuty 已剔 leave（三層疊第 ③ 層 / fallback filter）
        minStartMin: date === today ? nowMin + clinic.leadTimeMin : null,
        openSch,
        bookings: wd.bookings.get(date)?.get(pid) ?? [],
        holds: wd.holds.get(date)?.get(pid) ?? [],
        grid: apricotId ? (wd.grid.get(date)?.get(apricotId) ?? []) : [],
      }
      const evalr = evaluateProviderDay(ctx, includeFragments)
      if (!evalr) continue
      for (const s of evalr.offerable) {
        const start = minToHHmm(s.startMin)
        daySlots.push({
          start,
          end: minToHHmm(s.endMin),
          providerId: pid,
          providerName: wd.providerName.get(pid) ?? '',
          seatsFree: s.seatsFree,
          remainingCapacity: s.seatsFree,
          slotKey: signSlotKey({ clinicCode, date, start, providerId: pid, unitMin: 30 }),
        })
      }
    }
    daySlots.sort((a, b) => a.start.localeCompare(b.start) || a.providerName.localeCompare(b.providerName))
    return { date, closed, offerableCount: daySlots.length, slots: daySlots }
  })
}

// ─── claim（硬保留）───────────────────────────────────────────────────

/** 409 專用 — 帶 claim 上下文俾 route 算 alternatives */
export class SlotTakenError extends Error {
  constructor(
    readonly context: { clinicCode: string; providerId: string; date: string; startMin: number },
    readonly alternatives: SlotOut[] = [],
  ) {
    super('slot_taken')
    this.name = 'SlotTakenError'
  }
}

export interface ClaimInput {
  slotKey: string
  patientWaId: string
  patientName: string | null
  source: string
  flowToken: string
  visitReasonId: string | null
  requestedBy: string
}

export interface ClaimResult {
  hold: {
    id: string
    date: string
    startMin: number
    endMin: number
    providerId: string
    providerName: string
    status: string
    createdAt: Date
  }
  /** false = flowToken 冪等重放（同 hold） */
  created: boolean
  /** Apricot write 結果（response 唔回顯 — 只 audit） */
  apricot: { outcome: 'written' | 'skipped' | 'failed'; reason?: string }
}

/**
 * claim 單一交易內嘅 slot 驗證（MD §三.2 鐵律：交易內重算，唔信任
 * client 攞 response 到而家嘅中間狀態）。唔 offerable → throw SlotTakenError。
 */
async function claimInTx(
  tx: Prisma.TransactionClient,
  args: {
    clinic: ClinicSlotConfig
    provider: { id: string; name: string; apricotId: string | null }
    parts: { clinicCode: string; date: string; start: string; providerId: string; unitMin: number }
  },
): Promise<void> {
  const { clinic, provider, parts } = args
  const date = parts.date
  const startMin = hhmmToMin(parts.start)
  const endMin = startMin + 30

  // ★ 交易內重算（MD 鐵律：唔信任 client 攞 response 到而家嘅中間狀態）
  const [openSchRows, bookRows, holdRows, leaves, gridRows] = await Promise.all([
    tx.providerAvailability.findMany({
      where: { clinicId: clinic.id, providerId: provider.id, date },
      select: { startTime: true, endTime: true },
    }),
    tx.providerBooking.findMany({
      where: { clinicId: clinic.id, providerId: provider.id, date, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
      select: { startMin: true, endMin: true },
    }),
    tx.providerHold.findMany({
      where: { clinicId: clinic.id, providerId: provider.id, date, status: { in: [...ACTIVE_HOLD_STATUSES] } },
      select: { startMin: true, endMin: true },
    }),
    tx.providerLeave.findMany({
      where: { providerId: provider.id, startDate: { lte: hkDateEnd(date) }, endDate: { gte: hkDateStart(date) } },
      select: { startDate: true, endDate: true },
    }),
    tx.availabilityCache.findMany({
      where: { clinicId: clinic.id, providerApricotId: provider.apricotId ?? '', date, isOpen: true },
      select: { startTime: true, endTime: true, bookedCount: true },
    }),
  ])

  const openSch: Interval[] | null =
    openSchRows.length > 0
      ? openSchRows
          .map((r) => ({ startMin: hhmmToMin(r.startTime), endMin: hhmmToMin(r.endTime) }))
          .filter((r) => r.endMin > r.startMin)
      : null
  const onLeave = leaves.length > 0
  const now = new Date()
  const ctx: DayContext = {
    capacity: clinic.capacityPerProvider,
    onLeave,
    minStartMin: date === todayHK() ? nowMinHk(now) + clinic.leadTimeMin : null,
    openSch: openSch && openSch.length > 0 ? openSch : null,
    bookings: bookRows.map((r) => ({ startMin: r.startMin, endMin: r.endMin })),
    holds: holdRows.map((r) => ({ startMin: r.startMin, endMin: r.endMin })),
    grid: provider.apricotId
      ? gridRows.map((r) => ({ startMin: hhmmToMin(r.startTime), endMin: hhmmToMin(r.endTime), bookedCount: r.bookedCount }))
      : [],
  }
  const evalr = evaluateProviderDay(ctx)
  const slot = evalr?.slots.find((s) => s.startMin === startMin)
  if (!evalr || !slot || slot.status !== 'offerable') {
    throw new SlotTakenError({ clinicCode: parts.clinicCode, providerId: provider.id, date, startMin })
  }
}

/**
 * claim 主流程：
 *   1) flowToken 冪等（同 token → 同 hold；Meta 重試唔佔兩個位）
 *   2) 單一交易：交易內重算 offerable → 插/復用 hold（partial unique index 兜
 *      同毫秒 race；P2002 → 409）
 *   3) APRICOT_WRITE=1 → createBooking（獨立 connection；成功 IN_APRICOT，
 *      失敗留 HELD — MD §四：前台補入路徑）
 */
export async function claimSlot(input: ClaimInput): Promise<ClaimResult> {
  const parts = verifySlotKey(input.slotKey)
  if (!parts) throw new ExternalApiError(400, 'invalid slotKey', 'BAD_REQUEST')

  const clinic = await resolveSlotClinic(parts.clinicCode)
  const provider = await basePrisma.provider.findUnique({
    where: { id: parts.providerId },
    select: { id: true, name: true, apricotId: true },
  })
  if (!provider) throw new ExternalApiError(404, 'provider not found', 'PROVIDER_NOT_FOUND')
  const linked = await basePrisma.providerClinic.findFirst({
    where: { clinicId: clinic.id, providerId: provider.id },
    select: { id: true },
  })
  if (!linked) throw new ExternalApiError(400, 'slot not issued for this clinic', 'BAD_REQUEST')

  // 1) 冪等：同 flowToken
  const startMin = hhmmToMin(parts.start)
  const existing = await basePrisma.providerHold.findUnique({ where: { flowToken: input.flowToken } })
  if (existing && existing.status !== 'RELEASED') {
    // 同 token 但唔同 slot → client 狀態錯亂（唔係 slot race）
    if (existing.providerId !== provider.id || existing.date !== parts.date || existing.startMin !== startMin) {
      throw new ExternalApiError(409, 'flow token already used', 'FLOW_TOKEN_REUSED')
    }
    // 重放 → 同 hold；HELD 會自愈重試 Apricot write
    return {
      hold: {
        id: existing.id,
        date: existing.date,
        startMin: existing.startMin,
        endMin: existing.endMin,
        providerId: existing.providerId,
        providerName: provider.name,
        status: existing.status,
        createdAt: existing.createdAt,
      },
      created: false,
      apricot: await maybeWriteApricot(clinic, provider, existing, input),
    }
  }

  // 2) 單一交易：重算 + 佔位
  let holdRow: { id: string; date: string; startMin: number; endMin: number; providerId: string }
  try {
    holdRow = await basePrisma.$transaction(async (tx) => {
      // 交易內重算（SlotTakenError 會 roll back — 無寫入）
      await claimInTx(tx, { clinic, provider, parts })
      const releaseReuse = existing && existing.status === 'RELEASED' ? existing : null
      if (releaseReuse) {
        // RELEASED 舊行復用（保 flowToken UNIQUE + 冪等穩定：同 token 永遠同 holdId）
        const updated = await tx.providerHold.update({
          where: { id: releaseReuse.id },
          data: {
            clinicId: clinic.id,
            providerId: provider.id,
            date: parts.date,
            startMin,
            endMin: startMin + 30,
            patientWaId: input.patientWaId,
            patientName: input.patientName,
            source: input.source,
            status: 'HELD',
            apricotRef: null,
            committedAt: null,
          },
          select: { id: true, date: true, startMin: true, endMin: true, providerId: true },
        })
        return updated
      }
      return tx.providerHold.create({
        data: {
          clinicId: clinic.id,
          providerId: provider.id,
          date: parts.date,
          startMin,
          endMin: startMin + 30,
          patientWaId: input.patientWaId,
          patientName: input.patientName,
          source: input.source,
          status: 'HELD',
          flowToken: input.flowToken,
        },
        select: { id: true, date: true, startMin: true, endMin: true, providerId: true },
      })
    })
  } catch (e) {
    if (e instanceof SlotTakenError) throw e
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      // 同毫秒 race：partial unique（slot）或 flowToken unique 命中。
      // 同 token 對手赢咗 → 對手嗰條就係「我哋」→ 重放語義回 201。
      const winner = await basePrisma.providerHold.findUnique({ where: { flowToken: input.flowToken } })
      if (winner && winner.status !== 'RELEASED' &&
          winner.providerId === provider.id && winner.date === parts.date && winner.startMin === startMin) {
        return {
          hold: {
            id: winner.id,
            date: winner.date,
            startMin: winner.startMin,
            endMin: winner.endMin,
            providerId: winner.providerId,
            providerName: provider.name,
            status: winner.status,
            createdAt: winner.createdAt,
          },
          created: false,
          apricot: await maybeWriteApricot(clinic, provider, winner, input),
        }
      }
      throw new SlotTakenError({ clinicCode: parts.clinicCode, providerId: provider.id, date: parts.date, startMin })
    }
    throw e
  }

  // 3) Apricot write（HELD 落定先寫 — 寫失敗 hold 照留；成功先 IN_APRICOT）
  const fullHold = {
    id: holdRow.id,
    date: holdRow.date,
    startMin: holdRow.startMin,
    endMin: holdRow.endMin,
    providerId: holdRow.providerId,
    status: 'HELD' as string,
    apricotRef: null as string | null,
    createdAt: new Date(),
  }
  const apricot = await maybeWriteApricot(clinic, provider, fullHold, input)
  const statusAfter = apricot.outcome === 'written' ? 'IN_APRICOT' : 'HELD'

  // audit（🔴 零 PII：source/status/slot/providerId/apricot outcome）
  auditHold('PROVIDER_HOLD_CLAIM', { id: fullHold.id, clinicId: clinic.id }, {
    source: input.source,
    statusAfter,
    date: parts.date,
    startMin,
    endMin: startMin + 30,
    providerId: provider.id,
    apricot: apricot.outcome,
    ...(apricot.reason ? { reason: apricot.reason } : {}),
  })

  return {
    hold: { ...fullHold, providerName: provider.name, status: statusAfter },
    created: true,
    apricot,
  }
}

/**
 * Apricot write（APRICOT_WRITE=1 先走；任何 skip/fail 都留 HELD — MD §四）。
 * 🔴 patient {name, phone: waId}（HK WA = 電話；MD T4「patient_phone 空=WA 號」）。
 * visitReasonId：body > env APRICOT_DEFAULT_VISIT_REASON_ID > 缺 → skip（spec gap
 * 註記：MD claim body 冇 visitReasonId；缺時唔硬造，留 HELD 俾前台補）。
 * idempotencyKey = hold-<holdId>（穩定 — replay 自愈）。
 */
async function maybeWriteApricot(
  clinic: ClinicSlotConfig,
  provider: { id: string; name: string; apricotId: string | null },
  hold: { id: string; date: string; startMin: number; status: string; apricotRef: string | null },
  input: ClaimInput,
): Promise<{ outcome: 'written' | 'skipped' | 'failed'; reason?: string }> {
  if (hold.status === 'IN_APRICOT') return { outcome: 'written' }
  if (!isApricotWriteEnabled()) return { outcome: 'skipped', reason: 'write_disabled' }
  if (!clinic.apricotClinicId) return { outcome: 'skipped', reason: 'clinic_no_apricot_id' }
  const visitReasonId = input.visitReasonId ?? process.env.APRICOT_DEFAULT_VISIT_REASON_ID?.trim() ?? null
  if (!visitReasonId) return { outcome: 'skipped', reason: 'missing_visit_reason' }
  if (!isNewPatientWriteEnabled()) return { outcome: 'skipped', reason: 'new_patient_disabled' }
  if (!provider.apricotId) return { outcome: 'skipped', reason: 'provider_no_apricot_id' }
  const apricotClinicId = clinic.apricotClinicId
  const providerApricotId = provider.apricotId

  try {
    const res = await createBooking({
      idempotencyKey: `hold-${hold.id}`,
      clinicCuid: clinic.id,
      apricotClinicId,
      providerApricotId,
      dateHk: hold.date,
      startHk: minToHHmm(hold.startMin),
      durationMin: 30,
      visitReasonId,
      patient: { name: input.patientName ?? '線上預約', phone: input.patientWaId },
      requestedBy: input.requestedBy,
    })
    await basePrisma.providerHold
      .update({
        where: { id: hold.id },
        data: { status: 'IN_APRICOT', apricotRef: res.apricotApptId, committedAt: new Date() },
      })
      .catch((err) => console.error('[bookable-slots] hold IN_APRICOT 更新失敗（Apricot 已寫入 — 對帳用 hold-<id>）', err))
    return { outcome: 'written' }
  } catch (e) {
    // MD §四：寫入失敗 → 留 HELD（唔 fail 單 — 前台補入路徑）
    const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : String(e)
    console.error(`[bookable-slots] Apricot write 失敗（hold=${hold.id} 留 HELD）code=${code}`)
    return { outcome: 'failed', reason: code }
  }
}

// ─── alternatives（409 帶最新可出位 — MD §三.2）─────────────────────

/**
 * 409 alternatives（MD §三.2「被搶 409 必須連同最新替代時段」）：
 * 同醫生最近位先（最多 3），不足 2 補其他當值醫生（MD 例 3.2 混合兩醫生）。
 * 總上限 3，只出 startMin ≥ afterStartMin（「最新」= 由被搶位之後起計）。
 */
export async function computeAlternatives(
  clinic: ClinicSlotConfig,
  providerId: string,
  date: string,
  afterStartMin: number,
): Promise<SlotOut[]> {
  const wd = await loadWindowData(clinic, date, date, null)
  const days = buildDays(clinic, wd)
  const day = days[0]
  if (!day) return []
  const candidates = day.slots.filter((s) => hhmmToMin(s.start) >= afterStartMin)
  const same = candidates.filter((s) => s.providerId === providerId)
  const others = candidates.filter((s) => s.providerId !== providerId)
  // 同醫生 2+ 位 → 全出同醫生（最多 3）；不足 2 → 補其他醫生（總上限 3）
  const out: SlotOut[] = same.slice(0, 3)
  if (out.length < 2) {
    for (const s of others) {
      if (out.length >= 3) break
      out.push(s)
    }
  }
  return out.slice(0, 3)
}

// ─── commit / release（MD §三.3）─────────────────────────────────────

export async function commitHold(holdId: string, apricotRef: string | null): Promise<{ holdId: string; status: string; committedAt: Date | null }> {
  const hold = await basePrisma.providerHold.findUnique({ where: { id: holdId } })
  if (!hold) throw new ExternalApiError(404, 'hold not found', 'HOLD_NOT_FOUND')
  if (hold.status === 'RELEASED') throw new ExternalApiError(409, 'hold already released', 'HOLD_RELEASED')
  if (hold.status === 'IN_APRICOT') {
    return { holdId: hold.id, status: hold.status, committedAt: hold.committedAt }
  }
  const committedAt = new Date()
  await basePrisma.providerHold.update({
    where: { id: hold.id },
    data: { status: 'IN_APRICOT', committedAt, apricotRef: apricotRef ?? hold.apricotRef },
  })
  auditHold('PROVIDER_HOLD_COMMIT', { id: hold.id, clinicId: hold.clinicId }, {
    date: hold.date,
    startMin: hold.startMin,
    endMin: hold.endMin,
    providerId: hold.providerId,
    hasApricotRef: Boolean(apricotRef ?? hold.apricotRef),
  })
  return { holdId: hold.id, status: 'IN_APRICOT', committedAt }
}

export async function releaseHold(holdId: string): Promise<{ holdId: string; status: string; apricotRef: string | null }> {
  const hold = await basePrisma.providerHold.findUnique({ where: { id: holdId } })
  if (!hold) throw new ExternalApiError(404, 'hold not found', 'HOLD_NOT_FOUND')
  if (hold.status !== 'RELEASED') {
    await basePrisma.providerHold.update({ where: { id: hold.id }, data: { status: 'RELEASED' } })
    auditHold('PROVIDER_HOLD_RELEASE', { id: hold.id, clinicId: hold.clinicId }, {
      date: hold.date,
      startMin: hold.startMin,
      endMin: hold.endMin,
      providerId: hold.providerId,
      fromStatus: hold.status,
      // apricotRef 入 notes 係 Apricot 記錄號（非 PII）— 俾前台跟進清理 Apricot 邊
      hasApricotRef: Boolean(hold.apricotRef),
    })
  }
  return { holdId: hold.id, status: 'RELEASED', apricotRef: hold.apricotRef }
}

// ─── 自動 RELEASED（lazy sweep — MD §四：預約時間已過仍 HELD）────────

/**
 * 預約時間已過（endMin ≤ now，或日期已過）仍 HELD → RELEASED + audit。
 * lazy：GET bookable-slots / held endpoint 入火（fire-and-forget，唔阻回應）。
 */
export async function sweepPastHolds(clinicId: string | null, now: Date = new Date()): Promise<number> {
  const today = toHKDateStr(now)
  const nowMin = nowMinHk(now)
  const past = await basePrisma.providerHold.findMany({
    where: {
      status: 'HELD',
      ...(clinicId ? { clinicId } : {}),
      OR: [{ date: { lt: today } }, { date: today, endMin: { lte: nowMin } }],
    },
    // 防 backlog 一次性 audit 爆量 — 剩餘下次 sweep 再收
    take: 200,
    select: { id: true, clinicId: true, providerId: true, date: true, startMin: true, endMin: true },
  })
  if (past.length === 0) return 0
  const res = await basePrisma.providerHold.updateMany({
    where: { id: { in: past.map((h) => h.id) }, status: 'HELD' },
    data: { status: 'RELEASED' },
  })
  if (res.count > 0) {
    await basePrisma.auditLog
      .createMany({
        data: past.map((h) => ({
          actorId: null,
          action: 'PROVIDER_HOLD_AUTO_RELEASE',
          entity: 'ProviderHold',
          entityId: h.id,
          clinicId: h.clinicId,
          notes: JSON.stringify({ date: h.date, startMin: h.startMin, endMin: h.endMin, providerId: h.providerId }),
        })),
      })
      .catch((err) => console.error('[bookable-slots] auto-release audit 寫入失敗', err))
  }
  return res.count
}

/** fire-and-forget 版（route 層用） */
export function sweepPastHoldsSafe(clinicId: string | null): void {
  sweepPastHolds(clinicId).catch((err) => console.error('[bookable-slots] sweep 失敗', err))
}

// ─── held PII-free 讀（inbox 警報用 — MD 交貨 #7）──────────────────

export interface HeldRow {
  holdId: string
  date: string
  startMin: number
  endMin: number
  providerId: string
  providerName: string
  status: string
  source: string
  createdAt: string
  ageHours: number
  appointmentPast: boolean
}

/**
 * 🔴 零病人資料：holdId/date/startMin/endMin/providerId/providerName/
 * status/source/createdAt/ageHours/appointmentPast — 無 patientWaId/patientName。
 * holdTimeoutHours 由 caller（route）入 response 頂層俾 T3 算 severity。
 */
export async function listHolds(
  clinic: ClinicSlotConfig | null,
  status: string | null,
  now: Date = new Date(),
): Promise<HeldRow[]> {
  // 先 sweep（等佢 — held endpoint 唔係 3s SLA 路徑；令警報數據即時正確）
  await sweepPastHolds(clinic?.id ?? null, now)

  const rows = await basePrisma.providerHold.findMany({
    where: {
      status: status ? { equals: status } : { in: [...ACTIVE_HOLD_STATUSES] },
      ...(clinic ? { clinicId: clinic.id } : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, date: true, startMin: true, endMin: true, providerId: true, status: true, source: true, createdAt: true },
  })
  if (rows.length === 0) return []
  const providers = await basePrisma.provider.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.providerId))] } },
    select: { id: true, name: true },
  })
  const pName = new Map(providers.map((p) => [p.id, p.name]))
  const today = toHKDateStr(now)
  const nowMin = nowMinHk(now)
  const nowMs = now.getTime()
  return rows.map((r) => ({
    holdId: r.id,
    date: r.date,
    startMin: r.startMin,
    endMin: r.endMin,
    providerId: r.providerId,
    providerName: pName.get(r.providerId) ?? '',
    status: r.status,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    ageHours: Math.max(0, Math.round(((nowMs - r.createdAt.getTime()) / 3600000) * 10) / 10),
    appointmentPast: r.date < today || (r.date === today && r.endMin <= nowMin),
  }))
}
