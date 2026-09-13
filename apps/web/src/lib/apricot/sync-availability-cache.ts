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
import { assertNoPii, extractIndexRows } from './sanitize-availability'
import type { SanitizedIndexRow } from './sanitize-availability'

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
  indexRows: number // ★ cwc-rdchain-20260823-a1: AppointmentIndex upsert 行數
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

// ★ cwm-slotsafe-20260913：佔用規則由【白名單】改【黑名單】—— fail-safe。
//   點解：Apricot 狀態下拉有九個（Booked/Arrived/Ready for Consultation/In Consultation/
//   Checkout/Completed/No Show/Rescheduled/Cancelled），但我哋只見過七個碼。
//   「Ready for Consultation」「In Consultation」係過渡狀態（病人喺度嗰幾分鐘），
//   sync 週期多數撞唔到 —— 但撞到就會當佢空位。白名單一定再中。
//   ⚠️ 預設「當佔用」：估錯只係少做一單；估錯另一邊係 double-book，病人白行。
//
//   2026-09-13 實測（老細由 Apricot 畫面確認 1 = Arrived）：
//     0=Booked · 1=Arrived · 102=Rescheduled           → 計佔用
//     4=Completed/Checkout · -3 · -6 · -7（No Show／取消）→ 已釋放
//   ⚠️ 只有【明確知道「完咗／唔嚟」】先准入 RELEASED —— 有疑問一律唔加。
const RELEASED_BOOKING_STATUSES = new Set([4, -3, -6, -7])
const KNOWN_BOOKING_STATUSES = new Set([0, 1, 4, 102, -3, -6, -7])

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
 *   ★ cwm-slotsafe-20260913（MD §0 佔用規則，白名單→黑名單 fail-safe）：
 *   只剔 RELEASED_BOOKING_STATUSES {4, -3, -6, -7}（完咗／取消／No Show）；
 *   未知狀態碼一律當佔用（另發 unknown_booking_status alert）。
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
        // ★ A2：!RELEASED → 未知碼一律當佔用（fail-safe，見上面 A1 註釋）
        b => b.date === sch.date && !RELEASED_BOOKING_STATUSES.has(b.status) && b.startMin < slotEnd && b.endMin > cur,
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
 *
 * ★ cw-apricotwrite-20260823-a1（MD §4）：opts.dateOnly = 單日 mode（startDate=endDate=該日，
 *   決定性重寫只限該店該日）。全範圍 path 邏輯零改動。
 *
 * ★ cwc-rdchain-20260823-a1（read-chain MD §3.1/§3.2）：同一個 response 逐單（sanitize 後）
 *   加餵兩張索引表：
 *   - AppointmentIndex upsert 全欄（apricotApptId 唯一鍵；**唔剷歷史行** — 治療摘要來源）
 *   - PatientIndex upsert（patientApricotId 唯一鍵；lastSeenAt=now）
 *   - phoneNum → phoneHash() 後即棄 raw（extractIndexRows 白名單 v2 落地）
 *   - unknown bookingStatus → ALERT unknown_booking_status（§0）
 *   opts.start/end + indexOnly = 低頻 history mode（-7→昨日）：只 upsert 兩索引表，
 *   唔寫 AvailabilityCache（見檔尾 runAvailabilityHistorySync 註解 + 報告偏離）。
 */
export async function syncAvailabilityCacheForClinic(
  clinic: { id: string; name?: string; apricotClinicId: string },
  callFn: CacheCallFn = defaultCall,
  opts: { now?: Date; dateOnly?: string; start?: string; end?: string; indexOnly?: boolean } = {},
): Promise<{ rows: number; indexRows: number }> {
  const now = opts.now ?? new Date()
  // 窗口：單日 mode = 該日；history mode = opts.start/end（-7→昨日）；全範圍 = today → +30 日
  const start = opts.dateOnly ?? opts.start ?? toHKDateStr(now)
  const end = opts.dateOnly ?? opts.end ?? addDaysStr(start, WINDOW_DAYS)

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
  type IndexedRow = SanitizedIndexRow & { providerApricotId: string; providerName: string }
  const indexRows: IndexedRow[] = []
  const unknownStatuses = new Set<number>()
  for (const [dateStr, dayNode] of Object.entries(raw ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue // 過濾非日期 key（meta 之類）
    if (opts.dateOnly && dateStr !== opts.dateOnly) continue // 單日 mode：只数該日（防 Apricot 回隔壁日）
    if (opts.indexOnly && (dateStr < start || dateStr > end)) continue // history mode：只追窗口內日期（防越界）
    const appts = (dayNode as any)?.appointments
    if (!appts || typeof appts !== 'object') continue

    for (const [apricotPid, node] of Object.entries(appts)) {
      const providerName = nameByApricotId.get(apricotPid)
      if (!providerName) continue // 未對應 Provider 嘅 practitioner 跳過（唔硬造，同 §2.1）
      const openSches = extractOpenSch(dateStr, node)
      const bookings = extractBookings(dateStr, node)
      // ★ MD §0：未知 bookingStatus → 照存 + alert（呢度攞全集，cover 無 patient 筆）
      for (const b of bookings) {
        if (!KNOWN_BOOKING_STATUSES.has(b.status)) unknownStatuses.add(b.status)
      }
      for (const slot of buildSlotGrid(openSches, bookings)) {
        gridRows.push({
          clinicId: clinic.id,
          providerApricotId: apricotPid,
          providerName, // 快照（本系統 Provider.name — 對外顯示用）
          syncedAt: now,
          ...slot,
        })
      }
      // ★ 白名單 v2：booking 級 index 行（phoneNum→hash 已喺 extractor 即棄 raw）
      for (const r of extractIndexRows(dateStr, node)) {
        indexRows.push({ ...r, providerApricotId: apricotPid, providerName })
      }
    }
  }

  // ★ MD §0/§3.4：unknown bookingStatus alert（每店每 run 每個值一次，唔 spam）
  for (const v of [...unknownStatuses].sort((a, b) => a - b)) {
    console.error(
      `[availability-cache] ⚠️ ALERT unknown_booking_status — value=${v}（clinic=${clinic.name ?? clinic.apricotClinicId}）— 照存並【當佔用】（fail-safe），報 CEO 核對 Apricot 狀態碼後入 KNOWN/RELEASED`,
    )
  }

  if (!opts.indexOnly) {
    // 🔴 落地前 PII 白名單 assert（defence in depth — throw 會令該店記 fail）
    assertNoPii(gridRows)

    await prisma.$transaction([
      // 全範圍 mode：全店重寫（含過期行）；單日 mode：只決定性重寫該店該日（鐵律：唔郁其他日）
      prisma.availabilityCache.deleteMany({ where: { clinicId: clinic.id, ...(opts.dateOnly ? { date: opts.dateOnly } : {}) } }),
      prisma.availabilityCache.createMany({ data: gridRows, skipDuplicates: true }),
    ])
  }

  // ★ cwc-rdchain-20260823-a1（§3.1）：兩張索引表 upsert（高頻/單日/history 三 mode 都餵）
  // 🔴 落地前 PII assert（index 行承載 remarks 自由文字 — assertNoPii 用 key 掃描語義）
  if (indexRows.length > 0) assertNoPii(indexRows)

  const patientById = new Map<string, { patientApricotId: string; patientCode: string; patientName: string; phoneHash: string }>()
  for (const r of indexRows) {
    const full = {
      clinicId: clinic.id,
      providerApricotId: r.providerApricotId,
      providerName: r.providerName,
      date: r.date,
      startTime: r.startTime,
      endTime: r.endTime,
      bookingStatus: r.bookingStatus,
      patientApricotId: r.patientApricotId,
      patientCode: r.patientCode,
      patientName: r.patientName,
      phoneHash: r.phoneHash,
      visitReasons: r.visitReasons,
      remarks: r.remarks,
      syncedAt: now,
    }
    await prisma.appointmentIndex.upsert({
      where: { apricotApptId: r.apricotApptId },
      update: full,
      create: { apricotApptId: r.apricotApptId, ...full },
    })
    // PatientIndex 去重（同一病人多筆 booking 只 upsert 一次）；
    // phoneHash 合併規則：非空覆蓋空；空唔覆蓋非空（phoneNum 缺失 ≠ 換咗電話）
    const prev = patientById.get(r.patientApricotId)
    if (!prev) {
      patientById.set(r.patientApricotId, {
        patientApricotId: r.patientApricotId,
        patientCode: r.patientCode,
        patientName: r.patientName,
        phoneHash: r.phoneHash,
      })
    } else if (r.phoneHash && !prev.phoneHash) {
      patientById.set(r.patientApricotId, { ...prev, phoneHash: r.phoneHash })
    }
  }
  for (const p of patientById.values()) {
    await prisma.patientIndex.upsert({
      where: { patientApricotId: p.patientApricotId },
      update: { patientCode: p.patientCode, patientName: p.patientName, phoneHash: p.phoneHash, lastSeenAt: now },
      create: { ...p, lastSeenAt: now },
    })
  }

  return { rows: gridRows.length, indexRows: indexRows.length }
}

// ─── §4 單日即時 sync（cw-apricotwrite-20260823-a1 / MD §4）────────────
// 落單/改狀態/刪單/改期成功後，喺同一把 withApricotLock 內即行 —
// API 回 200 嗰刻 cache 已經新鮮，consumer 唔使等 15 分鐘 cron。
// 15 分鐘全範圍 cron 照舊（追診所端改動）；single-day 只係寫入後嘅即時補丁。

export interface SingleDayResult {
  dayRefreshed: true
  syncedAt: string // ISO UTC
}

/**
 * 單日 mode：startDate = endDate = 該日 → 一 call → sanitize → 只決定性重寫該店該日。
 *
 * 🚫 唔自己攞 lock — caller 必須已經喺 withApricotLock 內（寫入引擎同 sync 共鎖；
 *    advisory lock 喺 connection pool 下唔保證 reentrant，重攞會攞唔到而靜默 skip）。
 *    獨立要行用 runAvailabilityCacheSync({ clinicId, dateOnly })（有 lock 版）。
 */
export async function syncAvailabilityCacheSingleDay(
  clinic: { id: string; apricotClinicId: string },
  dateOnly: string,
  opts: { callFn?: CacheCallFn; now?: Date } = {},
): Promise<SingleDayResult> {
  const syncedAt = opts.now ?? new Date()
  await syncAvailabilityCacheForClinic(
    { id: clinic.id, apricotClinicId: clinic.apricotClinicId },
    opts.callFn ?? defaultCall,
    { now: syncedAt, dateOnly },
  )
  return { dayRefreshed: true, syncedAt: syncedAt.toISOString() }
}

// ─── 外層：lock 一次包住所有店 ──────────────────────────────────────────

/**
 * 逐間診所 sync（MD §B.2：六店順序，唔並發；一間失敗唔中斷其餘）。
 *
 * ★★★ withApricotLock 攞唔到 lock 回 null（唔係 throw）→ { ok: false, skipped }
 * AUTH_EXPIRED → 剩餘店唔再打（同 runAvailabilitySync 口徑 — 續打只會刷 log）。
 */
// Overloads（TS）：
//   單日 mode（MD §4）→ Promise<SingleDayResult>
//   全範圍 mode → Promise<CacheRunOutcome>（原有回傳型別 — 現有 caller/test 零改動）
export function runAvailabilityCacheSync(opts: { callFn?: CacheCallFn; now?: Date; clinicId: string; dateOnly: string }): Promise<SingleDayResult>
export function runAvailabilityCacheSync(opts?: { callFn?: CacheCallFn; now?: Date }): Promise<CacheRunOutcome>
export async function runAvailabilityCacheSync(
  opts: { callFn?: CacheCallFn; now?: Date; clinicId?: string; dateOnly?: string } = {},
): Promise<CacheRunOutcome | SingleDayResult> {
  const { callFn, now } = opts

  // ★ MD §4 單日 mode：runAvailabilityCacheSync({ clinicId, dateOnly }) —
  //   獨立入路（有 lock 版）；寫入引擎唔行呢度（佢哋自己攞 lock，行 no-lock 版）。
  if (opts.clinicId && opts.dateOnly) {
    const result = await withApricotLock(async () => {
      const clinic = await prisma.clinic.findUnique({
        where: { id: opts.clinicId! },
        select: { id: true, apricotClinicId: true },
      })
      const apricotClinicId = clinic?.apricotClinicId
      if (!apricotClinicId) {
        throw new Error(`[availability-cache] clinic ${opts.clinicId} 無 apricotClinicId`)
      }
      return await syncAvailabilityCacheSingleDay(
        { id: opts.clinicId!, apricotClinicId },
        opts.dateOnly!,
        { callFn, now },
      )
    })
    if (result === null) {
      throw new Error('[availability-cache] 單日 sync skip：another apricot call in progress')
    }
    return result
  }

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
        results.push({ clinic: c.name, clinicId: c.id, rows: r.rows, indexRows: r.indexRows })
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

// ─── §3.2 低頻 history 段（cwc-rdchain-20260823-a1 / read-chain MD §3.2/§3.4）──
// 每晚 03:00（掛現有 cron 機制 — 見 scripts/sync-availability-history.sh + 部署 checklist）：
//   範圍 -7 → 昨日，同一 engine 行（withApricotLock 照鎖，六店順序唔並發）—
//   只為追 status 變化（0→4／負數），AppointmentIndex/PatientIndex 同樣 upsert。
//
// ★ 偏離（報告已註記）：MD §3.2「三表同樣 upsert」落實為**兩索引表 upsert**，
//   AvailabilityCache 唔寫歷史日 — 過去 slot grid 無 consumer（availability API 係俾
//   未來 booking 用），而且 15 分鐘全範圍 run 每次 deleteMany(全店) 都會先剷走歷史 cache 行，
//   每晚寫入 = 幾分鐘後就清走嘅純 churn。status 追跟目的由兩索引表完整覆蓋。
//
// §3.4 監控：低頻 fail 共用現有 alert（同一 consecutiveRunFails 計數器 —
//   連續 3 次 fail → availability_sync_failed ALERT 行）。

export interface HistoryClinicResult {
  clinic: string
  clinicId: string
  indexRows: number
}

export interface HistoryRunResult {
  ok: true
  start: string // HK 今日 -7（YYYY-MM-DD）
  end: string   // 昨日（YYYY-MM-DD）
  results: Array<HistoryClinicResult | { clinic: string; clinicId: string; error: string }>
}

export type HistoryRunOutcome = HistoryRunResult | CacheRunSkipped

const HISTORY_PATHNAME = '/api/internal/sync-availability-history' // run label（共用 fail 計數器）
/** MD §3.2：低頻窗口 = -7 → 昨日（7 個日曆日） */
export const HISTORY_WINDOW_DAYS = 7

export async function runAvailabilityHistorySync(
  opts: { callFn?: CacheCallFn; now?: Date } = {},
): Promise<HistoryRunOutcome> {
  const { callFn, now } = opts
  const today = toHKDateStr(now ?? new Date())
  const start = addDaysStr(today, -HISTORY_WINDOW_DAYS)
  const end = addDaysStr(today, -1)

  const result = await withApricotLock(async () => {
    const clinics = await prisma.clinic.findMany({
      where: { apricotClinicId: { not: null } },
      select: { id: true, name: true, apricotClinicId: true },
      orderBy: { name: 'asc' },
    })

    const results: HistoryRunResult['results'] = []
    let runFailed = false
    for (const c of clinics) {
      if (!c.apricotClinicId) continue // where 已 filter；運行時多一層防御
      try {
        const r = await syncAvailabilityCacheForClinic(
          { id: c.id, name: c.name, apricotClinicId: c.apricotClinicId },
          callFn,
          { now, start, end, indexOnly: true },
        )
        results.push({ clinic: c.name, clinicId: c.id, indexRows: r.indexRows })
      } catch (e: any) {
        runFailed = true
        const msg = e?.message ?? String(e)
        // 🔴 只 log 錯誤訊息（Apricot error 無病人資料）—— raw response 絕對唔入 log
        console.error(`[availability-history] ${c.name} 失敗：`, msg)
        results.push({ clinic: c.name, clinicId: c.id, error: msg })
        if (msg.includes('AUTH_EXPIRED')) {
          console.error('[availability-history] Apricot 認證失效 —— 剩餘診所唔再打，bot 帳號要重新登入（報 CEO）')
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

  // §3.4：低頻 fail 共用現有 alert（同一計數器 — 連續 3 次 fail → availability_sync_failed）
  if (result.runFailed) recordRunFail(HISTORY_PATHNAME)
  else recordRunOk(HISTORY_PATHNAME)

  return { ok: true, start, end, results: result.results }
}
