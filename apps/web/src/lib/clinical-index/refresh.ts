// ============================================================
// 手動刷新（按病人）— cwi-followup-p1-20260915 — MD §2.8
//
// POST /api/external/v1/patients/{cpId}/refresh（scope: patients）
//   → 即時打 Apricot 三條（appointments / consultation-notes / bills，唯讀）
//   → upsertVisitIndex()（同夜跑同一個 upsert 路徑 — 唔係另一條管道）
//   → 200 { v:1, syncedAt, visits, balance }
//   → 429 { error:'rate limited', retryAfterSec }（bucket 拒）
//   → 503 { error:'APRICOT_UNAVAILABLE', lastSyncedAt }（唔扮成功）
//   → 404 { error:'PATIENT_NOT_FOUND' }（既無 appointment 又無索引行）
//
// 四層保護（MD §2.8）：
//   1. 同一病人 60 秒一次 — token bucket `refresh:patient:{cpId}`（capacity 1 / 60s）
//   2. 全店每分鐘 20 次 — token bucket `refresh:clinic:{clinicId}`（capacity 20 / 60s）
//   3. 自動靜默刷新 — consumer（wa-inbox）睇 syncedAt > 24h 自動跑（本端只暴露 syncedAt）
//   4. 失敗唔扮無事 — Apricot 斷 → 503 + lastSyncedAt
//
// Audit：PATIENT_RECORD_REFRESHED（記 staffId + cpId + 結果，零病人內容）。
//
// in-memory bucket（單 process；重啟即清 — 同 external-api.ts 同一認可口徑）。
// ============================================================

import { basePrisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { llmStats, resetLlmStats } from '@/lib/clinical/llm-client'
import {
  makeThrottledCallFn,
  isStopNightError,
  getPatientAppointments,
  getPatientNotes,
  getPatientBills,
} from './apricot-client'
import { resolvePatientDay, upsertVisitIndex, buildClinicMap } from './visit-index'
import { loadRxCodeEntries } from '@/lib/clinical/extract-rx-codes'
import { storeQuotesForVisit } from '@/lib/clinical/quote-extract'
import type { ClinicalCallFn } from './types'

export interface RefreshBucketResult {
  ok: boolean
  retryAfterSec: number
}

interface Bucket {
  tokens: number
  ts: number
}

const PATIENT_BUCKET = { capacity: 1, refillPerSec: 1 / 60 } // 60 秒一次
const CLINIC_BUCKET = { capacity: 20, refillPerSec: 20 / 60 } // 每分鐘 20 次

const buckets = new Map<string, Bucket>()

/** 測試用：清空 bucket（同 resetExternalRateBuckets 同一慣例）。 */
export function resetClinicalRefreshBuckets(): void {
  buckets.clear()
}

function takeToken(key: string, rate: { capacity: number; refillPerSec: number }): RefreshBucketResult {
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) {
    b = { tokens: rate.capacity, ts: now }
    buckets.set(key, b)
  } else {
    b.tokens = Math.min(rate.capacity, b.tokens + ((now - b.ts) / 1000) * rate.refillPerSec)
    b.ts = now
  }
  if (b.tokens >= 1) {
    b.tokens -= 1
    return { ok: true, retryAfterSec: 0 }
  }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / rate.refillPerSec)) }
}

/**
 * 保護 1+2：先扣 patient bucket（更嚴）；patient 過但 clinic 拒 → 還返 patient token
 * （避免 clinic 層拒卻誤鎖病人 60 秒）。
 */
export function takeRefreshTokens(clinicId: string, cpId: string): RefreshBucketResult {
  const p = takeToken(`refresh:patient:${cpId}`, PATIENT_BUCKET)
  if (!p.ok) return p
  const c = takeToken(`refresh:clinic:${clinicId}`, CLINIC_BUCKET)
  if (!c.ok) {
    const pb = buckets.get(`refresh:patient:${cpId}`)!
    pb.tokens = Math.min(PATIENT_BUCKET.capacity, pb.tokens + 1)
    return c
  }
  return { ok: true, retryAfterSec: 0 }
}

export class ApricotUnavailableError extends Error {
  constructor() {
    super('APRICOT_UNAVAILABLE')
    this.name = 'ApricotUnavailableError'
  }
}

export type RefreshResult =
  | {
      ok: true
      visitDate: string
      syncedAt: string
      visits: number
      balance: { ttlAmt: number | null; osAmt: number | null }
    }
  | { ok: false; reason: 'NOT_FOUND' }

/**
 * 單一病人即時刷新（正好三 call：appointments → notes → bills，順序執行）。
 * 目標日 = 最新 past appointment 日（≤ today）；無 appointment → fallback
 * 索引行（≤ today 最新）；都冇 → NOT_FOUND（route 回 404）。
 * Apricot 限速/認證/未配置 → throw ApricotUnavailableError（route 回 503）。
 */
export async function refreshPatientIndex(
  cpId: string,
  opts: { callFn?: ClinicalCallFn; now?: Date } = {},
): Promise<RefreshResult> {
  const now = opts.now ?? new Date()
  resetLlmStats() // ★ cwi-final S0-9：job 開頭重置 — 完結 log 反映本 job LLM 產出
  const today = toHKDateStr(now)
  const { call } = makeThrottledCallFn(opts.callFn)
  const phoneKey = process.env.PHONE_HASH_KEY ?? ''
  const clinicMap = await buildClinicMap()
  const rxCodeEntries = await loadRxCodeEntries()

  // Call 1：appointments（決定目標日）
  let appointments: any[]
  try {
    appointments = await getPatientAppointments(call, cpId)
  } catch (e) {
    if (isStopNightError(e)) throw new ApricotUnavailableError()
    throw e
  }

  // 目標日：最新 past appointment（≤ today）
  let targetDay: string | null = null
  for (const a of appointments) {
    const t = a?.conTime ?? a?.checkInTime
    if (typeof t === 'string' && t.length >= 10) {
      const day = toHKDateStr(t)
      if (day <= today && (!targetDay || day > targetDay)) targetDay = day
    }
  }

  // fallback：索引行（≤ today 最新）— 病人係經 phoneHash 匹配搵到嘅，正常必有行
  if (!targetDay) {
    const row = await basePrisma.clinicalRecordIndex.findFirst({
      where: { patientApricotId: cpId, visitDate: { lte: new Date(`${today}T00:00:00Z`) } },
      orderBy: { visitDate: 'desc' },
      select: { visitDate: true },
    })
    if (!row) return { ok: false, reason: 'NOT_FOUND' }
    targetDay = toHKDateStr(row.visitDate)
  }

  // Call 2+3：notes + bills（目標日）
  let notes: any[]
  let bills: any[]
  try {
    notes = await getPatientNotes(call, cpId)
    bills = await getPatientBills(call, cpId, targetDay)
  } catch (e) {
    if (isStopNightError(e)) throw new ApricotUnavailableError()
    throw e
  }

  // 病人主檔欄：appointment 行帶 clinicPatient（PII 只用於 hash/代號，唔回傳）
  const cp = appointments[0]?.clinicPatient ?? {}
  const patient = {
    cpId,
    code: cp.code,
    phoneNum: cp.phoneNum,
    registrationClinic: appointments[0]?.clinicId ?? cp.registrationClinic,
  }

  const v = resolvePatientDay({ patient, appointments, notes, bills, day: targetDay, clinicMap, phoneKey, rxCodeEntries })
  if (v) await upsertVisitIndex(v)

  const row = await basePrisma.clinicalRecordIndex.findFirst({
    where: {
      patientApricotId: cpId,
      visitDate: new Date(`${targetDay}T00:00:00Z`),
      apricotApptId: v?.apricotApptId ?? null,
    },
    orderBy: { syncedAt: 'desc' },
  })

  // S3：手動刷新同步抽報價（best-effort — 唔阻 refresh 回應）
  if (v?.hasNote && v.noteJson && row) {
    try {
      // ★ cwm-leaveasoffix-20260923 S5-3：呢度係 POST /api/external/v1/patients/{id}/refresh 嘅 request path，
      //   429 重試（sleep ≤10s ×2 + 每次 fetch 上限 35s）最壞會拖 55 秒 → nginx/CF 切 504。手動刷新唔重試。
      await storeQuotesForVisit({ visitId: row.id, clinicId: v.clinicId, patientApricotId: v.patientApricotId, visitDate: new Date(`${targetDay}T00:00:00Z`), note: v.noteJson as any, llmMaxAttempts: 1 })
    } catch (e) {
      console.error('[quote-extract] 存儲失敗（唔阻 refresh）:', e)
    }
  }

  // ★ cwi-final S0-9：job 完結 log — 睇到「LLM 層零產出」
  console.log(`[clinical-index-refresh] done visits=${row ? 1 : 0} llm: ${JSON.stringify(llmStats())}`)
  return {
    ok: true,
    visitDate: targetDay,
    syncedAt: row?.syncedAt?.toISOString() ?? now.toISOString(),
    visits: row ? 1 : 0,
    balance: { ttlAmt: row?.billTtlAmt ?? null, osAmt: row?.billOsAmt ?? null },
  }
}
