// ★ cw-extapi-20260823-a1: Availability cache sync（external API v1 數據源，MD §B.2）
//
// 每 15 分鐘（掛入現有 cron：POST /api/internal/sync-availability）逐間店 sync
//   today → +30 日 嘅 slot grid 入 AvailabilityCache。
//
// 🔴 PII 紅線（同 sync-availability.ts 同級）：本檔永不 log raw response
//    （內嵌病人 HKID／病歷／電話）。只 log 結構統計（行數／店名）。
//    書寫前最後一關：assertNoPii（搬入嘅 sanitize-availability.ts 白名單 assert）。
//
// 序列化鐵律：withApricotLock（advisory lock 776001）包住所有店 —— 同 bill/payment
//    sync 共用一個 lock key，嚴格序列化打 Apricot。六店順序，唔並發。
//
// 可重用性：callFn 可注入（預設 = 真 apricotCall + retry）；dev/測試傳自己嘅函數。
//
// 偏離 MD（報告已註記）：
//   - 「date < 今日 每晚剷」實現成每次 sync 前逐店 deleteMany（全店 window 決定性重寫，
//     過期行自然剷走 — 冪等、更強，唔開新 cron 項目）。
//   - 連續失敗計數係 run 級（一輪入面任一店 fail = 該輪 fail）；in-memory 計數，
//     重啟歸零。現有 repo 無外部警報通道 → console.error + 結構 log（MD fallback）。
import { prisma } from '@/lib/prisma'
import { toHKDateStr, addDaysStr } from '@/lib/hk-date'
import { apricotCall, withApricotLockRetry } from './client'
import { withApricotLock } from './lock'
import { extractOpenSch, extractBookings } from './availability'
import type { OpenSchRow, BookingRow } from './availability'
import { assertNoPii } from './sanitize-availability'

// ─── Types ──────────────────────────────────────────────────────────────

export type CacheCallFn = (path: string) => Promise<any>

export interface CacheSlotRow {
  clinicId: string
  providerApricotId: string
  providerName: string
  date: string
  startTime: string
  endTime: string
  isOpen: boolean
  bookedCount: number
  syncedAt: Date
}

export interface CacheClinicResult {
  clinic: string
  clinicId: string
  rows: number
}

export interface CacheRunResult {
  ok: true
  start: string // HK 今日（YYYY-MM-DD）
  end: string   // +30 日
  results: Array<CacheClinicResult | { clinic: string; clinicId: string; error: string }>
}

export interface CacheRunSkipped {
  ok: false
  skipped: string
}

export type CacheRunOutcome = CacheRunResult | CacheRunSkipped

/** 預設 call：真 Apricot + retry（503/busy 重試；AUTH/RATE 直接 throw，唔重試） */
const defaultCall: CacheCallFn = (path) => withApricotLockRetry(() => apricotCall(path))

const APPOINTMENTS_PATH = '/services/aepsmsappt/api/appointments/getOverviewAppointments'
const CLINIC_DELAY_MS = 500
/** MD §B.2.1：日期範圍 = 今日 → +30 日（31 個日曆日） */
const WINDOW_DAYS = 30
/** MD §C.1：stale = syncedAt 距今 > 30 分鐘（route + test 共用） */
export const STALE_AFTER_MS = 30 * 60 * 1000
/** MD §B.2.6：連續 3 次 sync fail → alert */
const FAIL_ALERT_THRESHOLD = 3
/** slot grid 粒度（分鐘）— Phase 2 偵察：Apricot booking 邊界落在 30 分鐘格上 */
const SLOT_STEP_MIN = 30

const PATHNAME = '/api/external/v1/availability' // audit/monitor 識別用（本檔唔寫 audit）

// ─── 連續失敗計數（in-memory，run 級）──────────────────────────────────
// 現有 repo 無外部警報通道（grep alert/monitor 零命中）→ MD fallback：
// console.error（每輪 fail）+ 達標時 console.error ALERT 行。
let consecutiveRunFails = 0

/** 測試用：重置計數 */
export function resetCacheFailCounter(): void {
  consecutiveRunFails = 0
}

export function getCacheConsecutiveFails(): number {
  return consecutiveRunFails
}

function recordRunFail(runLabel: string): void {
  consecutiveRunFails += 1
  console.error(
    `[availability-cache] ${runLabel} 同步失敗（consecutive ${consecutiveRunFails}/${FAIL_ALERT_THRESHOLD}）`,
  )
  if (consecutiveRunFails >= FAIL_ALERT_THRESHOLD) {
    // 🔴 MD §B.2.6 alert — 現有無外部警報通道，呢行係警報落點（cron log /tmp/availability-sync.log）
    console.error(
      `[availability-cache] ⚠️ ALERT availability_sync_failed — 連續 ${consecutiveRunFails} 次 sync 失敗（報 CEO 檢查 Apricot 認證/網路）`,
    )
  }
}

function recordRunOk(runLabel: string): void {
  if (consecutiveRunFails > 0) {
    console.log(`[availability-cache] ${runLabel} 恢復正常（之前連續失敗 ${consecutiveRunFails} 次）`)
  }
  consecutiveRunFails = 0
}

// ─── Slot grid 計算（純函數，test-first 友好）───────────────────────────

function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

/**
 * 一個醫生某日嘅 slot grid：openSch 開診時段 × 30 分鐘格。
 *
 * bookedCount = 同該格【重疊】嘅 booking 數（b.start < slotEnd && b.end > slotStart）—
 *   預約佔住醫生，重疊即唔空。isRemoved/跨日/壞格式筆已經被 extractBookings 剔走。
 * isOpen：格喺 openSch 時段內 → true（開診先有格；冇開診就冇格，唔硬造）。
 */
export function buildSlotGrid(openSches: OpenSchRow[], bookings: BookingRow[]): Omit<CacheSlotRow, 'clinicId' | 'providerApricotId' | 'providerName' | 'syncedAt'>[] {
  const rows: Omit<CacheSlotRow, 'clinicId' | 'providerApricotId' | 'providerName' | 'syncedAt'>[] = []
  for (const sch of openSches) {
    const s = hhmmToMin(sch.startTime)
    const e = hhmmToMin(sch.endTime)
    if (e <= s) continue // 壞時段（extractor 已 filter，多一層防御）
    for (let cur = s; cur < e; cur += SLOT_STEP_MIN) {
      const slotEnd = Math.min(cur + SLOT_STEP_MIN, e) // 尾格可以短於 30 分鐘
      const bookedCount = bookings.filter(
        b => b.date === sch.date && b.startMin < slotEnd && b.endMin > cur,
      ).length
      rows.push({
        date: sch.date,
        startTime: minToHHmm(cur),
        endTime: minToHHmm(slotEnd),
        isOpen: true,
        bookedCount,
      })
    }
  }
  return rows
}

// ─── §B.2 單間診所 sync ─────────────────────────────────────────────────

/**
 * 一次 call 拎晒 today → +30 日，逐日逐醫生做 slot grid，決定性重寫該店全部 cache row。
 *
 * ★★★ 決定性寫（同 syncAvailability 同模式）：一個 $transaction 內
 *   deleteMany（該店全部 row — 過期行同 window 外行一齊剷走）→ createMany。
 *   AvailabilityCache 只由呢個 engine 寫入 → 全店重寫安全。
 *
 * 🔴 sanitize 白名單：raw 經 extractOpenSch/extractBookings（只抽 primitive）→
 *    slot grid 只有白名單欄位 → assertNoPii 落地前最後兜底（throw = 該店 fail）。
 */
export async function syncAvailabilityCacheForClinic(
  clinic: { id: string; name?: string; apricotClinicId: string },
  callFn: CacheCallFn = defaultCall,
  opts: { now?: Date } = {},
): Promise<{ rows: number }> {
  const now = opts.now ?? new Date()
  const start = toHKDateStr(now)
  const end = addDaysStr(start, WINDOW_DAYS)

  // ★ MD §B.2.1 字面：doctorIds = 全部 Provider.apricotId != null（唔 filter isActive）。
  //   新醫生規則：未入 Provider 表嘅醫生永遠唔會喺空檔資料出現（要 admin 先入表）。
  const providers = await prisma.provider.findMany({
    where: { apricotId: { not: null } },
    select: { apricotId: true, name: true },
  })
  if (providers.length === 0) {
    throw new Error('[availability-cache] 冇任何 provider 有 apricotId —— 補齊先再 sync')
  }
  const nameByApricotId = new Map(providers.map(p => [p.apricotId!, p.name]))

  const qs = new URLSearchParams()
  qs.set('startDate', start)
  qs.set('endDate', end)
  // 同 syncAvailability 同參數口徑：clinicIds（List）+ openSchClinicId（單數）都要傳
  qs.append('clinicIds', clinic.apricotClinicId)
  qs.set('openSchClinicId', clinic.apricotClinicId)
  for (const p of providers) qs.append('doctorIds', p.apricotId!)

  // ★ 必填參數自檢（同 syncAvailability — 漏一個 Apricot 回 400，log 冇人睇）
  const REQUIRED = ['startDate', 'endDate', 'clinicIds', 'openSchClinicId'] as const
  const missing = REQUIRED.filter(k => !qs.get(k))
  if (missing.length > 0) {
    throw new Error(`[availability-cache] query 缺必填參數：${missing.join(', ')}`)
  }

  // ★ 只 call —— raw 零 log 零 disk；retry 處理 503/busy；lock 由外層負責
  const raw = await callFn(`${APPOINTMENTS_PATH}?${qs.toString()}`)

  const gridRows: CacheSlotRow[] = []
  for (const [dateStr, dayNode] of Object.entries(raw ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue // 過濾非日期 key（meta 之類）
    const appts = (dayNode as any)?.appointments
    if (!appts || typeof appts !== 'object') continue

    for (const [apricotPid, node] of Object.entries(appts)) {
      const providerName = nameByApricotId.get(apricotPid)
      if (!providerName) continue // 未對應 Provider 嘅 practitioner 跳過（唔硬造，同 §2.1）
      const openSches = extractOpenSch(dateStr, node)
      const bookings = extractBookings(dateStr, node)
      for (const slot of buildSlotGrid(openSches, bookings)) {
        gridRows.push({
          clinicId: clinic.id,
          providerApricotId: apricotPid,
          providerName, // 快照（本系統 Provider.name — 對外顯示用）
          syncedAt: now,
          ...slot,
        })
      }
    }
  }

  // 🔴 落地前 PII 白名單 assert（defence in depth — throw 會令該店記 fail）
  assertNoPii(gridRows)

  await prisma.$transaction([
    prisma.availabilityCache.deleteMany({ where: { clinicId: clinic.id } }), // 決定性：全店重寫（含過期行）
    prisma.availabilityCache.createMany({ data: gridRows, skipDuplicates: true }),
  ])

  return { rows: gridRows.length }
}

// ─── 外層：lock 一次包住所有店 ──────────────────────────────────────────

/**
 * 逐間診所 sync（MD §B.2：六店順序，唔並發；一間失敗唔中斷其餘）。
 *
 * ★★★ withApricotLock 攞唔到 lock 回 null（唔係 throw）→ { ok: false, skipped }
 * AUTH_EXPIRED → 剩餘店唔再打（同 runAvailabilitySync 口徑 — 續打只會刷 log）。
 */
export async function runAvailabilityCacheSync(
  opts: { callFn?: CacheCallFn; now?: Date } = {},
): Promise<CacheRunOutcome> {
  const { callFn, now } = opts
  const runStart = toHKDateStr(now ?? new Date())

  const result = await withApricotLock(async () => {
    const clinics = await prisma.clinic.findMany({
      where: { apricotClinicId: { not: null } },
      select: { id: true, name: true, apricotClinicId: true },
      orderBy: { name: 'asc' },
    })

    const results: CacheRunResult['results'] = []
    let runFailed = false
    for (const c of clinics) {
      if (!c.apricotClinicId) continue // where 已 filter；運行時多一層防御
      try {
        const r = await syncAvailabilityCacheForClinic(
          { id: c.id, name: c.name, apricotClinicId: c.apricotClinicId },
          callFn,
          { now },
        )
        results.push({ clinic: c.name, clinicId: c.id, rows: r.rows })
      } catch (e: any) {
        runFailed = true
        const msg = e?.message ?? String(e)
        // 🔴 只 log 錯誤訊息（Apricot error 無病人資料）—— raw response 絕對唔入 log
        console.error(`[availability-cache] ${c.name} 失敗：`, msg)
        results.push({ clinic: c.name, clinicId: c.id, error: msg })
        if (msg.includes('AUTH_EXPIRED')) {
          console.error('[availability-cache] Apricot 認證失效 —— 剩餘診所唔再打，bot 帳號要重新登入（報 CEO）')
          break
        }
      }
      await new Promise(r => setTimeout(r, CLINIC_DELAY_MS))
    }
    return { results, runFailed }
  })

  if (result === null) {
    return { ok: false, skipped: 'another apricot call in progress' }
  }

  // run 級連續失敗計數（MD §B.2.6）
  if (result.runFailed) recordRunFail(PATHNAME)
  else recordRunOk(PATHNAME)

  return { ok: true, start: runStart, end: addDaysStr(runStart, WINDOW_DAYS), results: result.results }
}
