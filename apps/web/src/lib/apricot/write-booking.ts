// ============================================================
// Apricot 預約寫入引擎（MD v2.0 §3 + §0 實測證據）— cw-apricotwrite-20260823-a1
//
// 老總已簽兩 checkbox（白名單 v2 + 自動化寫入同意）。
// flags 默認 off：APRICOT_WRITE=0（總閘）、ALLOW_NEW_PATIENT_WRITE=0（新客 inline）。
//
// 鐵律（MD §3 + 派工）：
//   - 全部動作行 withApricotLock（同 sync 共一把鎖 — iat 逐 request rotate，並發即死）
//   - 永不自動重試：寫入 call（create/status/remove）走 raw apricotCall（無 retry wrapper）；
//     只讀 call（checkClash/字典 GET/overview GET）先 withApricotLockRetry
//   - 任何 Apricot response 唔落 log（metadata only）— 成功 response 有病人資料，
//     只准 whitelist pickup 個別 primitive 欄
//   - WriteLog 零病人資料（只 metadata + apricotApptId）
//
// ⚠️ RECONSTRUCTED endpoints/fields（MD §0/§3 只提供部分 URL，v1.1 probe 腳本唔喺呢台機）：
//   - CHECK_CLASH_PATH（MD §3 偽碼 `…/checkClash/…/DOCTOR_LOCATION?…&bookingId=`）
//   - DICTIONARY_PATHS（MD 只講「兩條 GET」）
//   - create payload 除病人部分外嘅欄名（clinicId/practitionerId/bookingTime/...）
//   全部集中喺下面常數區 + buildBookingBody；**開 APRICOT_WRITE=1 前必逐項對 v1.1 probe 驗證**
//   （部署 checklist 有專項）。
// ============================================================

import { prisma } from '@/lib/prisma'
import { ExternalApiError } from '@/lib/external-api'
import { withApricotLock } from './lock'
import { apricotCall, withApricotLockRetry } from './client'
import { toHKDateStr } from '@/lib/hk-date'
import {
  syncAvailabilityCacheSingleDay,
} from './sync-availability-cache'

// ─── Endpoint 常數（§0 實測 + RECONSTRUCTED 標記）────────────────────

/** §0 實測：落單（舊客 clinicPatient:{id} / 新客 inline 自動開檔；唔傳 bookingType） */
const BOOKING_CREATE_PATH = '/services/aepsmsope/api/booking-details'
/** §0 實測：狀態（通用 endpoint，白名單只准 102 改期標記 / -7 取消） */
const BOOKING_STATUS_PATH = (apricotApptId: string, status: number) =>
  `/services/aepsmsope/api/appointments/${encodeURIComponent(apricotApptId)}/updateStatus?status=${status}`
/** §0 實測：刪單 — method 係 PUT 唔係 POST，body 係陣列 [id] */
const BOOKING_REMOVE_PATH = '/services/aepsmsope/api/booking-details/remove?recurApplyType=0'
/**
 * ⚠️ RECONSTRUCTED — MD §3 偽碼 `…/checkClash/…/DOCTOR_LOCATION?…&bookingId=` 重建。
 * 新單 bookingId 傳空。開寫前必須對 v1.1 probe 驗證。
 */
const CHECK_CLASH_PATH = (
  providerApricotId: string,
  apricotClinicId: string,
  sUtc: string,
  eUtc: string,
) =>
  `/services/aepsmsappt/api/appointments/checkClash/${encodeURIComponent(providerApricotId)}/${encodeURIComponent(apricotClinicId)}/DOCTOR_LOCATION?startDate=${sUtc}&endDate=${eUtc}&bookingId=`

/**
 * ⚠️ RECONSTRUCTED — MD 只講「兩條 GET」，具體 path 喺 v1.1 probe。開寫前必須驗證。
 */
const DICTIONARY_PATHS: Record<DictionaryKind, string> = {
  VISIT_REASON: '/services/aepsmsope/api/visit-reasons',
  BOOKING_TYPE: '/services/aepsmsope/api/booking-types',
}

// ─── Flags（默認 off — 第一階段）──────────────────────────────────────

/** 總閘：off → 所有寫入 route 503 WRITE_DISABLED */
export function isApricotWriteEnabled(): boolean {
  return (process.env.APRICOT_WRITE ?? '0').trim() === '1'
}
/** 新客 inline body：off → 422 NEW_PATIENT_DISABLED（行穩舊客一個月先開） */
export function isNewPatientWriteEnabled(): boolean {
  return (process.env.ALLOW_NEW_PATIENT_WRITE ?? '0').trim() === '1'
}

// ─── 錯誤型（route 層映射成 { error, code }）──────────────────────────

export type WriteStep = 'check_clash' | 'create' | 'status' | 'remove' | 'log' | 'sync_day'

export class ApricotWriteError extends Error {
  constructor(
    readonly code: string,
    readonly step: WriteStep | null,
    message: string,
  ) {
    super(message)
    this.name = 'ApricotWriteError'
  }
}

/** client.ts 拋出嘅 raw error（APRICOT_AUTH_EXPIRED / APRICOT_HTTP_500: ... 等）→ mapped */
function mapCallError(e: unknown, step: WriteStep): ApricotWriteError {
  const msg = e instanceof Error ? e.message : String(e)
  const code = msg.split(':')[0].trim() // APRICOT_HTTP_500: xxx → APRICOT_HTTP_500
  return new ApricotWriteError(code || 'APRICOT_ERROR', step, msg)
}

// ─── 時間 helper（HK = UTC+8，MD §0）─────────────────────────────────

/** 'YYYY-MM-DD' + 'HH:mm' → UTC ISO。`${date}T${hhmm}:00+08:00` → toISOString() */
export function hkToUtc(dateStr: string, hhmm: string): string {
  // 🔴 精確運算（唔用字符串 parse — V8 會將 2026-02-30 normalize 做 03-02，silent 錯日）
  const [y, m, day] = dateStr.split('-').map(Number)
  const [hh, mm] = hhmm.split(':').map(Number)
  if (![y, m, day, hh, mm].every((n) => Number.isInteger(n) && n >= 0) || m < 1 || m > 12) {
    throw new ApricotWriteError('INVALID_TIME', null, `invalid HK date/time: ${dateStr} ${hhmm}`)
  }
  const dayStart = new Date(Date.UTC(y, m - 1, day))
  // 偽日期檢查（2026-02-30 咁嘅入 Date.UTC 會 normalize — round-trip 對返先過）
  if (dayStart.getUTCFullYear() !== y || dayStart.getUTCMonth() !== m - 1 || dayStart.getUTCDate() !== day) {
    throw new ApricotWriteError('INVALID_TIME', null, `invalid HK date: ${dateStr}`)
  }
  if (hh > 23 || mm > 59) {
    throw new ApricotWriteError('INVALID_TIME', null, `invalid HK time: ${hhmm}`)
  }
  return new Date(dayStart.getTime() + hh * 3600_000 + mm * 60_000 - 8 * 3600_000).toISOString()
}

/** 'HH:mm' + N 分鐘 → 'HH:mm'（同日；越過 24:00 回 null — 預約唔準跨日） */
export function addMinutesHhmm(hhmm: string, min: number): string | null {
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + min
  if (total > 23 * 60 + 59) return null
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// ─── Types ───────────────────────────────────────────────────────────

/** 一個 Apricot HTTP round-trip（預設 = raw apricotCall — 寫入唔 retry） */
export type WriteCallFn = (path: string, init?: RequestInit) => Promise<any>

/**
 * 測試注入（acceptance only，同 internal/sync-availability/test-call-fn 模式）—
 * 生產永遠 null → 真 apricotCall。只供 contract test 離線驗證 200 路徑。
 */
let testCallFn: WriteCallFn | null = null
export function setTestCallFn(fn: WriteCallFn | null): void {
  testCallFn = fn
}
const defaultCall: WriteCallFn = (path, init) => (testCallFn ? testCallFn(path, init) : apricotCall(path, init))

/** 病人：舊客 = { apricotId }；新客 = { name, phone }（ALLOW_NEW_PATIENT_WRITE 守門） */
export type PatientRef = { apricotId: string } | { name: string; phone: string }

export interface CreateBookingInput {
  idempotencyKey: string
  /** 本系統 Clinic.id（single-day cache sync 用） */
  clinicCuid: string
  /** Apricot clinic id（payload + checkClash 用） */
  apricotClinicId: string
  providerApricotId: string
  dateHk: string    // YYYY-MM-DD
  startHk: string   // HH:mm
  durationMin: number
  visitReasonId: string
  remarks?: string
  patient: PatientRef
  requestedBy: string // external key name（WriteLog requestedBy，零 PII）
}

export interface CreateBookingResult {
  apricotApptId: string
  patientApricotId: string | null
  patientCode: string | null
  dayRefreshed: boolean
  syncedAt: string | null
  /** true = 冪等重放（同 apricotApptId，無新寫入、無 cache 重刷） */
  replayed: boolean
}

export interface MutationResult {
  dayRefreshed: boolean
  syncedAt: string | null
}

export interface RescheduleInput {
  oldApricotApptId: string
  clinicCuid: string
  apricotClinicId: string
  providerApricotId: string
  /** 舊單 HK 日期（refresh 舊日 cache 用） */
  oldDateHk: string
  newDateHk: string
  newStartHk: string
  newDurationMin: number
  visitReasonId?: string
  remarks?: string
  patient: PatientRef
  requestedBy: string
}

export interface EngineOpts {
  /** 測試注入（預設 = 真 apricotCall） */
  callFn?: WriteCallFn
  /** reschedule 內重用 createBookingLocked 時 — 新日 sync 由 caller 統一處理（避免重複打） */
  skipDaySync?: boolean
}

// ─── WriteLog（零 PII — 只 metadata）─────────────────────────────────

type LogShape = {
  action: 'CREATE' | 'STATUS_102' | 'STATUS_-7' | 'REMOVE' | 'RESCHEDULE'
  apricotApptId?: string | null
  status: string
  requestedBy: string
}

async function upsertWriteLog(idempotencyKey: string, shape: LogShape): Promise<void> {
  await prisma.bookingWriteLog.upsert({
    where: { idempotencyKey },
    update: { action: shape.action, apricotApptId: shape.apricotApptId ?? null, status: shape.status, requestedBy: shape.requestedBy },
    create: {
      idempotencyKey,
      action: shape.action,
      apricotApptId: shape.apricotApptId ?? null,
      status: shape.status,
      requestedBy: shape.requestedBy,
    },
  })
}

// ─── checkClash（§0：回 [] = 通過；length>0 = clash；非陣列 → warn 照行）──

async function checkClash(
  providerApricotId: string,
  apricotClinicId: string,
  sUtc: string,
  eUtc: string,
  call: WriteCallFn,
): Promise<boolean> {
  let data: any
  try {
    // 只讀 GET — 可 retry（lock/busy/503）
    data = await withApricotLockRetry(() => call(CHECK_CLASH_PATH(providerApricotId, apricotClinicId, sUtc, eUtc)))
  } catch (e) {
    throw mapCallError(e, 'check_clash')
  }
  if (Array.isArray(data)) return data.length > 0
  // ⚠️ 非陣列：MD 規則 = warn metadata 照行（response 內文絕唔落 log，只記形狀）
  console.warn('[write-booking] checkClash 回應非陣列 — 按 MD 規則繼續', {
    type: typeof data,
    keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 8).join(',') : null,
  })
  return false
}

// ─── 落單 ─────────────────────────────────────────────────────────────

/**
 * 組 booking-details POST body（MD §0 payload）。
 * - 舊客：clinicPatient: { id }
 * - 新客：inline { firstName, phoneNum, referralType:'OTHER', privateSetting:{clinics:[],isPrivate:false} } → 自動開檔
 * - bookingType 唔傳（§0 實測 optional）
 *
 * ⚠️ 欄名除病人部分外係 RECONSTRUCTED（clinicId/practitionerId/bookingTime/bookingEndTime/
 *    visitReasonId/remarkByDoctor）— 開寫前對 v1.1 probe 驗證。
 */
export function buildBookingBody(input: CreateBookingInput, sUtc: string, eUtc: string): Record<string, unknown> {
  const p = input.patient
  // ⚠️ 病人部分係 §0 實測證據（唯一確定嘅 payload 結構）
  const clinicPatient = 'apricotId' in p
    ? { id: p.apricotId }
    : {
        firstName: p.name,
        phoneNum: p.phone,
        referralType: 'OTHER',
        privateSetting: { clinics: [], isPrivate: false },
      }
  return {
    clinicId: input.apricotClinicId,
    practitionerId: input.providerApricotId,
    bookingTime: sUtc,
    bookingEndTime: eUtc,
    visitReasonId: input.visitReasonId,
    remarkByDoctor: input.remarks ?? '',
    clinicPatient,
  }
}

/**
 * 從 create response whitelist pickup（🔴 零 PII — 只三樣 primitive，response 唔 log 唔留）。
 * 欄名係 defensive 猜測（response 形狀以 8/8 實測為準）— 開寫前對 probe 驗證。
 */
function extractCreateResult(res: any): { apricotApptId: string | null; patientApricotId: string | null; patientCode: string | null } {
  const pick = (...vals: unknown[]): string | null => {
    for (const v of vals) if (typeof v === 'string' && v.trim()) return v
    return null
  }
  const patientNode = res?.clinicPatient ?? res?.patient
  return {
    apricotApptId: pick(res?.id, res?.apricotId, res?.bookingId, res?.appointmentId),
    patientApricotId: pick(patientNode?.id, patientNode?.apricotId, res?.patientId),
    patientCode: pick(patientNode?.code, patientNode?.patientCode, res?.patientCode),
  }
}

/**
 * 落單（冪等）。整個動作喺同一把 withApricotLock 內：
 *   冪等查 WriteLog → hkToUtc → checkClash → POST booking-details →
 *   WriteLog(OK) → 單日 sync（§4，同一把 lock 內）→ 回結果
 *
 * 冪等重放規則（同 key）：
 *   - OK → 同 apricotApptId（replayed:true，無新寫入）
 *   - SLOT_TAKEN → 409（確定性）
 *   - ERROR:check_clash / ERROR:create_rejected → 安全重試（單從來唔曾 reach Apricot / 確決被拒）
 *   - 其他（ERROR:create / ERROR:log / ...）→ 502 MANUAL_RECONCILE（殘留態人手跟，唔自動重試）
 */
export async function createBooking(input: CreateBookingInput, opts: EngineOpts = {}): Promise<CreateBookingResult> {
  const call = opts.callFn ?? defaultCall
  const outcome = await withApricotLock(() => createBookingLocked(input, call, opts.skipDaySync ? { skipDaySync: true } : undefined))
  if (outcome === null) {
    throw new ApricotWriteError('APRICOT_BUSY', null, 'another Apricot call in progress — retry later')
  }
  return outcome
}

/** 唔攞 lock 版（reschedule 喺同一把 lock 內重用；skipDaySync = caller 自己處理日 sync） */
async function createBookingLocked(input: CreateBookingInput, call: WriteCallFn, opts: { skipDaySync?: boolean } = {}): Promise<CreateBookingResult> {
  // 1) 冪等查
  const prior = await prisma.bookingWriteLog.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
  if (prior) {
    if (prior.status === 'OK' && prior.apricotApptId) {
      return {
        apricotApptId: prior.apricotApptId,
        patientApricotId: null,
        patientCode: null,
        dayRefreshed: false,
        syncedAt: null,
        replayed: true,
      }
    }
    if (prior.status === 'SLOT_TAKEN') {
      throw new ApricotWriteError('SLOT_TAKEN', 'check_clash', 'slot taken (idempotent replay)')
    }
    if (prior.status !== 'ERROR:check_clash' && prior.status !== 'ERROR:create_rejected') {
      throw new ApricotWriteError(
        'MANUAL_RECONCILE',
        null,
        `idempotency key ${input.idempotencyKey} prior state ${prior.status} — verify in Apricot manually`,
      )
    }
    // ERROR:check_clash / ERROR:create_rejected → 落返去重行（upsert 覆蓋同一行）
  }

  // 2) 時間
  const sUtc = hkToUtc(input.dateHk, input.startHk)
  const endHhmm = addMinutesHhmm(input.startHk, input.durationMin)
  if (!endHhmm) {
    throw new ApricotWriteError('INVALID_TIME', null, `booking crosses midnight: ${input.dateHk} ${input.startHk} +${input.durationMin}m`)
  }
  const eUtc = hkToUtc(input.dateHk, endHhmm)

  // 3) checkClash
  let clashing = false
  try {
    clashing = await checkClash(input.providerApricotId, input.apricotClinicId, sUtc, eUtc, call)
  } catch (e) {
    // 只記 metadata（step 級），Apricot 錯誤內文唔落 WriteLog
    await upsertWriteLog(input.idempotencyKey, { action: 'CREATE', status: 'ERROR:check_clash', requestedBy: input.requestedBy }).catch((err) =>
      console.error('[write-booking] WriteLog(ERROR:check_clash) 失敗', err),
    )
    throw e
  }
  if (clashing) {
    await upsertWriteLog(input.idempotencyKey, { action: 'CREATE', status: 'SLOT_TAKEN', requestedBy: input.requestedBy }).catch((err) =>
      console.error('[write-booking] WriteLog(SLOT_TAKEN) 失敗', err),
    )
    throw new ApricotWriteError('SLOT_TAKEN', 'check_clash', 'slot taken: Apricot checkClash found existing booking')
  }

  // 4) POST booking-details（🔴 raw call — 永不自動重試；response 唔 log）
  const body = buildBookingBody(input, sUtc, eUtc)
  let res: any
  try {
    res = await call(BOOKING_CREATE_PATH, { method: 'POST', body: JSON.stringify(body) })
  } catch (e) {
    const mapped = mapCallError(e, 'create')
    // 4xx = 確決拒絕（單冇落）→ 可安全重試；5xx/網絡/超時 = 曖昧（可能已落）→ 殘留態
    const definiteReject = mapped.code === 'APRICOT_HTTP_400' || mapped.code === 'APRICOT_HTTP_404' || mapped.code === 'APRICOT_HTTP_409' || mapped.code === 'APRICOT_HTTP_422'
    await upsertWriteLog(input.idempotencyKey, {
      action: 'CREATE',
      status: definiteReject ? 'ERROR:create_rejected' : 'ERROR:create',
      requestedBy: input.requestedBy,
    }).catch((err) => console.error('[write-booking] WriteLog(ERROR:create*) 失敗', err))
    throw mapped
  }

  // 5) whitelist pickup（response 零 log）
  const ext = extractCreateResult(res)
  if (!ext.apricotApptId) {
    // 落單成功但 response 冇可識別 id → 殘留態（response 形狀同 RECONSTRUCTED 不符 — 開寫前 probe 會兜住）
    await upsertWriteLog(input.idempotencyKey, { action: 'CREATE', status: 'ERROR:create', requestedBy: input.requestedBy }).catch(() => {})
    console.error('[write-booking] ⚠️ ALERT create 成功但 response 無 apricotApptId — 人手核對 Apricot（metadata only）', {
      clinicCuid: input.clinicCuid,
      date: input.dateHk,
    })
    throw new ApricotWriteError('MANUAL_RECONCILE', 'create', 'create succeeded but booking id not identifiable in response — verify in Apricot manually')
  }

  // 6) WriteLog(OK) — 冪等錨
  try {
    await upsertWriteLog(input.idempotencyKey, { action: 'CREATE', apricotApptId: ext.apricotApptId, status: 'OK', requestedBy: input.requestedBy })
  } catch {
    // 單已落但 OK 記錄寫唔到 → 留殘留記錄（帶 apricotApptId 俾 ops 對號）再報 MANUAL_RECONCILE
    await upsertWriteLog(input.idempotencyKey, { action: 'CREATE', apricotApptId: ext.apricotApptId, status: 'ERROR:log', requestedBy: input.requestedBy }).catch(() => {})
    console.error('[write-booking] ⚠️ ALERT create 成功但 WriteLog(OK) 失敗 — 人手核對', {
      clinicCuid: input.clinicCuid,
      date: input.dateHk,
    })
    throw new ApricotWriteError('MANUAL_RECONCILE', 'log', 'booking created but write-log record failed — verify manually')
  }

  // 7) ★ 單日即時 sync（§4 — 同一把 lock 內；fail 唔回滚，cron 15 分鐘內追）
  //    reschedule 場合：新日 sync 由 caller（rescheduleBooking 尾段，舊日+新日一次過）處理
  let dayRefreshed = false
  let syncedAt: string | null = null
  if (!opts.skipDaySync) {
    try {
      const r = await syncAvailabilityCacheSingleDay(
        { id: input.clinicCuid, apricotClinicId: input.apricotClinicId },
        input.dateHk,
        { callFn: (p: string) => withApricotLockRetry(() => call(p)) },
      )
      dayRefreshed = r.dayRefreshed
      syncedAt = r.syncedAt
    } catch (e) {
      console.error('[write-booking] ALERT 單日 sync 失敗（單已落，15 分鐘 cron 追補）— metadata only', {
        clinicCuid: input.clinicCuid,
        date: input.dateHk,
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return { apricotApptId: ext.apricotApptId, patientApricotId: ext.patientApricotId, patientCode: ext.patientCode, dayRefreshed, syncedAt, replayed: false }
}

// ─── 狀態 / 刪單 / 改期 ──────────────────────────────────────────────

/** 白名單（§0：我哋只准 102 改期標記 / -7 取消，其他值一律拒） */
export const ALLOWED_STATUS_VALUES = [102, -7] as const

export interface StatusMutationOpts extends EngineOpts {
  requestedBy: string
  clinicCuid: string
  apricotClinicId: string
  /** 單嘅 HK 日期（single-day sync 用 — consumer 傳入） */
  dateHk: string
}

/** PUT updateStatus（白名單 102 / -7）。同一把 lock 內：call → WriteLog → 單日 sync */
export async function updateBookingStatus(apricotApptId: string, status: number, opts: StatusMutationOpts): Promise<{ bookingStatus: number } & MutationResult> {
  if (!ALLOWED_STATUS_VALUES.includes(status as 102 | -7)) {
    throw new ApricotWriteError('STATUS_NOT_ALLOWED', 'status', `status ${status} not in whitelist (102 / -7)`)
  }
  const call = opts.callFn ?? defaultCall
  const action = status === 102 ? 'STATUS_102' : 'STATUS_-7'
  // 合成 key（呢類 action 無 consumer idempotencyKey — 唯一底帳）
  const logKey = `${action}|${apricotApptId}|${Date.now()}`

  const outcome = await withApricotLock(async () => {
    try {
      await call(BOOKING_STATUS_PATH(apricotApptId, status))
    } catch (e) {
      await upsertWriteLog(logKey, { action, apricotApptId, status: 'ERROR:status', requestedBy: opts.requestedBy }).catch(() => {})
      throw mapCallError(e, 'status')
    }
    await upsertWriteLog(logKey, { action, apricotApptId, status: 'OK', requestedBy: opts.requestedBy }).catch((err) =>
      console.error('[write-booking] WriteLog(OK status) 失敗', err),
    )
    const day = await refreshDay(opts, call)
    return { bookingStatus: status, ...day }
  })
  if (outcome === null) throw new ApricotWriteError('APRICOT_BUSY', null, 'another Apricot call in progress — retry later')
  return outcome
}

/** PUT remove（§0：method 係 PUT，body ["<id>"]）。同一把 lock 內 */
export async function removeBooking(apricotApptId: string, opts: StatusMutationOpts): Promise<{ removed: true } & MutationResult> {
  const call = opts.callFn ?? defaultCall
  const logKey = `REMOVE|${apricotApptId}|${Date.now()}`

  const outcome = await withApricotLock(async () => {
    try {
      await call(BOOKING_REMOVE_PATH, { method: 'PUT', body: JSON.stringify([apricotApptId]) })
    } catch (e) {
      await upsertWriteLog(logKey, { action: 'REMOVE', apricotApptId, status: 'ERROR:remove', requestedBy: opts.requestedBy }).catch(() => {})
      throw mapCallError(e, 'remove')
    }
    await upsertWriteLog(logKey, { action: 'REMOVE', apricotApptId, status: 'OK', requestedBy: opts.requestedBy }).catch((err) =>
      console.error('[write-booking] WriteLog(OK remove) 失敗', err),
    )
    const day = await refreshDay(opts, call)
    return { removed: true as const, ...day }
  })
  if (outcome === null) throw new ApricotWriteError('APRICOT_BUSY', null, 'another Apricot call in progress — retry later')
  return outcome
}

/** 同一把 lock 內 single-day sync（fail → ALERT + dayRefreshed:false，唔失敗主動作） */
async function refreshDay(opts: StatusMutationOpts, call: WriteCallFn): Promise<MutationResult> {
  try {
    const r = await syncAvailabilityCacheSingleDay(
      { id: opts.clinicCuid, apricotClinicId: opts.apricotClinicId },
      opts.dateHk,
      { callFn: (p: string) => withApricotLockRetry(() => call(p)) },
    )
    return { dayRefreshed: r.dayRefreshed, syncedAt: r.syncedAt }
  } catch (e) {
    console.error('[write-booking] ALERT 單日 sync 失敗（寫入已落，15 分鐘 cron 追補）— metadata only', {
      clinicCuid: opts.clinicCuid,
      date: opts.dateHk,
      err: e instanceof Error ? e.message : String(e),
    })
    return { dayRefreshed: false, syncedAt: null }
  }
}

/**
 * 改期（MD §3）：同一把 lock 內 102（舊單標記）→ create（新單）。
 * 新單 fail → WriteLog(ERROR:create_after_102) + ALERT，**唔自動 rollback**（已知殘留態，人手跟）。
 */
export async function rescheduleBooking(input: RescheduleInput, opts: EngineOpts = {}): Promise<{ oldApptId: string; newApptId: string } & MutationResult> {
  const call = opts.callFn ?? defaultCall
  const logKey = `RESCHEDULE|${input.oldApricotApptId}|${Date.now()}`

  const outcome = await withApricotLock(async () => {
    // 1) 舊單標 102（改期標記）
    try {
      await call(BOOKING_STATUS_PATH(input.oldApricotApptId, 102))
    } catch (e) {
      await upsertWriteLog(logKey, { action: 'RESCHEDULE', apricotApptId: input.oldApricotApptId, status: 'ERROR:status', requestedBy: input.requestedBy }).catch(() => {})
      throw mapCallError(e, 'status')
    }
    await upsertWriteLog(logKey, { action: 'RESCHEDULE', apricotApptId: input.oldApricotApptId, status: 'OK:102_marked', requestedBy: input.requestedBy }).catch(() => {})

    // 2) 新單（同病人；reuse createBookingLocked — 已經喺 lock 內；獨立子 key 避免覆蓋 102 底）
    let newResult: CreateBookingResult
    try {
      newResult = await createBookingLocked(
        {
          idempotencyKey: `${logKey}|create`,
          clinicCuid: input.clinicCuid,
          apricotClinicId: input.apricotClinicId,
          providerApricotId: input.providerApricotId,
          dateHk: input.newDateHk,
          startHk: input.newStartHk,
          durationMin: input.newDurationMin,
          visitReasonId: input.visitReasonId ?? '',
          remarks: input.remarks,
          patient: input.patient,
          requestedBy: input.requestedBy,
        },
        call,
        { skipDaySync: true },
      )
    } catch (e) {
      // ★ 已知殘留態：舊單已 102、新單 fail — 記底 + alert，唔自動 rollback
      await upsertWriteLog(`${logKey}|after102`, {
        action: 'RESCHEDULE',
        apricotApptId: input.oldApricotApptId,
        status: 'ERROR:create_after_102',
        requestedBy: input.requestedBy,
      }).catch(() => {})
      console.error(
        '[write-booking] ⚠️ ALERT reschedule 殘留態：舊單已標 102 但新單失敗 — 人手跟（唔自動 rollback）',
        { oldApptId: input.oldApricotApptId, oldDate: input.oldDateHk, newDate: input.newDateHk },
      )
      throw e
    }

    // 3) 兩日各 refresh 一次（舊日 + 新日；同日就只一次）
    const days = [...new Set([input.oldDateHk, input.newDateHk])]
    let dayRefreshed = false
    let syncedAt: string | null = null
    for (const d of days) {
      const day = await refreshDay(
        { requestedBy: input.requestedBy, clinicCuid: input.clinicCuid, apricotClinicId: input.apricotClinicId, dateHk: d },
        call,
      )
      if (day.dayRefreshed) dayRefreshed = true
      if (day.syncedAt) syncedAt = day.syncedAt
    }

    // 4) RESCHEDULE OK 底（帶新單 id）
    await upsertWriteLog(`${logKey}|ok`, { action: 'RESCHEDULE', apricotApptId: newResult.apricotApptId, status: 'OK', requestedBy: input.requestedBy }).catch(() => {})

    return { oldApptId: input.oldApricotApptId, newApptId: newResult.apricotApptId, dayRefreshed, syncedAt }
  })
  if (outcome === null) throw new ApricotWriteError('APRICOT_BUSY', null, 'another Apricot call in progress — retry later')
  return outcome
}

// ─── 字典 sync（nightly — 掛現有 cron tick，每日 HK 首個 tick 跑）──────

export type DictionaryKind = 'VISIT_REASON' | 'BOOKING_TYPE'
export const DICTIONARY_KINDS: DictionaryKind[] = ['VISIT_REASON', 'BOOKING_TYPE']

export interface DictionarySyncResult {
  synced: Partial<Record<DictionaryKind, number>>
  skipped: string[]
}

/**
 * 兩條 GET → ApricotDictionary upsert。
 * - 每日 HK 已 sync 過嘅 kind 自動 skip（→ 掛 15 分鐘 cron 就係 nightly，無新 cron 項）
 * - 單條 fail → 留舊 cache + continue（字典係快取，唔阻主 sync）
 * - 0 行 → 懷疑 response 形狀變 → 留舊 cache + warn（RECONSTRUCTED path 驗證前嘅安全網）
 */
export async function syncDictionaries(opts: { callFn?: WriteCallFn; force?: boolean; now?: Date } = {}): Promise<DictionarySyncResult> {
  const call = opts.callFn ?? defaultCall
  const outcome = await withApricotLock(async () => {
    const now = opts.now ?? new Date()
    const hkDay = toHKDateStr(now)
    const synced: Partial<Record<DictionaryKind, number>> = {}
    const skipped: string[] = []

    for (const kind of DICTIONARY_KINDS) {
      if (!opts.force) {
        const last = await prisma.apricotDictionary.findFirst({
          where: { kind },
          orderBy: { syncedAt: 'desc' },
          select: { syncedAt: true },
        })
        if (last && toHKDateStr(last.syncedAt) === hkDay) {
          skipped.push(kind)
          continue
        }
      }
      let data: any
      try {
        data = await withApricotLockRetry(() => call(DICTIONARY_PATHS[kind]))
      } catch (e) {
        console.error('[write-booking] 字典 sync 失敗（留舊 cache）— metadata only', { kind, err: e instanceof Error ? e.message : String(e) })
        skipped.push(kind)
        continue
      }
      const items = extractDictionaryItems(data)
      if (items.length === 0) {
        console.warn('[write-booking] 字典 sync 0 行（response 形狀可能變 — 留舊 cache）', { kind })
        skipped.push(kind)
        continue
      }
      await upsertDictionary(kind, items, now)
      synced[kind] = items.length
    }
    return { synced, skipped }
  })
  if (outcome === null) return { synced: {}, skipped: ['lock busy'] }
  return outcome
}

/** 白名單 pickup（字典係代碼表 — apricotId/code/des/isRemoved；response 唔 log） */
function extractDictionaryItems(raw: any): { apricotId: string; code: string; des: string; isRemoved: boolean }[] {
  const arr = Array.isArray(raw) ? raw
    : Array.isArray(raw?.list) ? raw.list
    : Array.isArray(raw?.data) ? raw.data
    : Array.isArray(raw?.content) ? raw.content
    : Array.isArray(raw?.rows) ? raw.rows
    : null
  if (!arr) return []
  const out: { apricotId: string; code: string; des: string; isRemoved: boolean }[] = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const apricotId = typeof it.id === 'string' && it.id ? it.id : typeof it.apricotId === 'string' && it.apricotId ? it.apricotId : null
    const code = typeof it.code === 'string' && it.code ? it.code : null
    if (!apricotId || !code) continue
    const des = (typeof it.des === 'string' && it.des) || (typeof it.description === 'string' && it.description) || (typeof it.name === 'string' && it.name) || code
    out.push({ apricotId, code, des, isRemoved: it.isRemoved === true || it.removed === true })
  }
  return out
}

async function upsertDictionary(kind: DictionaryKind, items: { apricotId: string; code: string; des: string; isRemoved: boolean }[], now: Date): Promise<void> {
  await prisma.$transaction(
    items.map((it) =>
      prisma.apricotDictionary.upsert({
        where: { apricotId: it.apricotId },
        update: { kind, code: it.code, des: it.des, isRemoved: it.isRemoved, syncedAt: now },
        create: { kind, apricotId: it.apricotId, code: it.code, des: it.des, isRemoved: it.isRemoved, syncedAt: now },
      }),
    ),
  )
}

// ─── route 層錯誤映射（5xx 洩 generic + code 帶 step — MD §5）─────────

/** ApricotWriteError → ExternalApiError（409/422/503/502 — response 零內文） */
export function mapWriteErrorToExternal(e: unknown): ExternalApiError {
  if (e instanceof ApricotWriteError) {
    if (e.code === 'SLOT_TAKEN') return new ExternalApiError(409, 'slot taken', 'SLOT_TAKEN')
    if (e.code === 'APRICOT_BUSY') return new ExternalApiError(503, 'another Apricot call in progress', 'APRICOT_BUSY')
    if (e.code === 'MANUAL_RECONCILE') return new ExternalApiError(502, 'apricot error — manual reconcile required', 'APRICOT_ERROR:manual_reconcile')
    if (e.code === 'INVALID_TIME' || e.code === 'STATUS_NOT_ALLOWED') return new ExternalApiError(400, e.message, 'BAD_REQUEST')
    const step = e.step ? `APRICOT_ERROR:${e.step}` : 'APRICOT_ERROR'
    return new ExternalApiError(502, 'apricot error', step)
  }
  return new ExternalApiError(500, 'internal error', 'INTERNAL')
}
