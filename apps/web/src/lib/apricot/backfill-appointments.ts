// ============================================================
// Backfill 一次性（read-chain MD §3.3）— cwc-rdchain-20260823-b1
//
// 範圍：-24 個月 → -7（HK 日界）。逐月逐店，經**同一把序列化 lock**
// （withApricotLock 776001 — 同高頻/低頻 sync 共用），**慢拉**（一次一店一 months，
// Apricot response 細，夜晚行唔撞高峰）。
//
// 只餵 **AppointmentIndex + PatientIndex**（indexOnly mode — 唔掂 AvailabilityCache，
// 過去 slot grid 無 consumer）。
//
// 冪等：AppointmentIndex/PatientIndex upsert 鍵係 apricotApptId / patientApricotId —
// **可中斷重跑**（重跑 = 同批 upsert 原樣覆寫，唔會雙寫）。
//
// 跑法（夜晚，CD apps/web）：
//   set -a && . ./.env.development && set +a \
//     && npx tsx scripts/backfill-appointments.ts
// ============================================================

import { prisma } from '@/lib/prisma'
import { toHKDateStr, addDaysStr, hkParts } from '@/lib/hk-date'
import { apricotCall, withApricotLockRetry } from './client'
import { withApricotLock } from './lock'
import { syncAvailabilityCacheForClinic } from './sync-availability-cache'
import type { CacheCallFn } from './sync-availability-cache'

export interface BackfillClinicMonthResult {
  clinic: string
  clinicId: string
  month: string // YYYY-MM
  indexRows: number
}

export interface BackfillRunResult {
  ok: true
  start: string // -24 個月該月初（YYYY-MM-DD）
  end: string   // -7 日（YYYY-MM-DD）
  results: Array<BackfillClinicMonthResult | { clinic: string; clinicId: string; month: string; error: string }>
  stats: {
    totalAppointments: number // AppointmentIndex 總行（全表）
    totalPatients: number     // PatientIndex 總行（全表）
    elapsedMs: number
  }
}

export interface BackfillSkipped {
  ok: false
  skipped: string
}

export type BackfillOutcome = BackfillRunResult | BackfillSkipped

/** MD §3.3：backfill 範圍 = -24 個月 → -7 */
export const BACKFILL_MONTHS = 24
export const BACKFILL_END_OFFSET_DAYS = 7
/** 慢拉間隔（每間店每月一次 call 之後 sleep；夜晚行防撞 Apricot 高峰） */
const DEFAULT_DELAY_MS = 1000

/** 預設 call：真 Apricot + retry（同 sync-availability-cache.ts 同一組合） */
const defaultCall: CacheCallFn = (path) => withApricotLockRetry(() => apricotCall(path))

/** [start, end] 涵蓋嘅月份（YYYY-MM，升序，首尾月可能係半個月） */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = []
  let [y, m] = start.slice(0, 7).split('-').map(Number)
  const [ey, em] = end.slice(0, 7).split('-').map(Number)
  for (let guard = 0; guard < 48 && (y < ey || (y === ey && m <= em)); guard++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

/** 'YYYY-MM' → 該月最後一日 'YYYY-MM-DD'（純 UTC 曆運算，零時區依賴） */
function monthEndStr(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate() // month index m = m+1 月 1 日 → 前一日 = 該月末日
  return `${ym}-${String(lastDay).padStart(2, '0')}`
}

/**
 * 跑 backfill（可注入 callFn/now/delayMs — 測試用；預設 = 真 Apricot）。
 *
 * 🔴 PII 紅線：raw response 永不 log（syncAvailabilityCacheForClinic 內部
 *    白名單 pickup + assertNoPii；呢度只 log 結構統計）。
 */
export async function runAppointmentIndexBackfill(
  opts: { callFn?: CacheCallFn; now?: Date; delayMs?: number } = {},
): Promise<BackfillOutcome> {
  const t0 = Date.now()
  const nowDate = opts.now ?? new Date()
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS

  const today = toHKDateStr(nowDate)
  const end = addDaysStr(today, -BACKFILL_END_OFFSET_DAYS)
  // -24 個月嘅月初（HK 視角純曆運算；m 0-based）
  const { y, m } = hkParts(nowDate)
  let sy = y
  let sm = m - BACKFILL_MONTHS
  while (sm < 0) { sm += 12; sy -= 1 }
  const start = `${sy}-${String(sm + 1).padStart(2, '0')}-01`

  if (start > end) {
    return { ok: true, start, end, results: [], stats: { totalAppointments: 0, totalPatients: 0, elapsedMs: Date.now() - t0 } }
  }

  // 逐月窗口（首尾月裁剪到 [start, end]）
  const windows = monthsBetween(start, end).map(ym => {
    const monthStart = `${ym}-01`
    const monthEnd = monthEndStr(ym)
    return { month: ym, ws: monthStart > start ? monthStart : start, we: monthEnd < end ? monthEnd : end }
  })

  const result = await withApricotLock(async () => {
    const clinics = await prisma.clinic.findMany({
      where: { apricotClinicId: { not: null } },
      select: { id: true, name: true, apricotClinicId: true },
      orderBy: { name: 'asc' },
    })

    const results: BackfillRunResult['results'] = []
    let aborted = false
    for (const w of windows) {
      for (const c of clinics) {
        if (!c.apricotClinicId) continue // where 已 filter；運行時多一層防御
        try {
          const r = await syncAvailabilityCacheForClinic(
            { id: c.id, name: c.name, apricotClinicId: c.apricotClinicId },
            opts.callFn ?? defaultCall,
            { now: nowDate, start: w.ws, end: w.we, indexOnly: true },
          )
          results.push({ clinic: c.name, clinicId: c.id, month: w.month, indexRows: r.indexRows })
        } catch (e: any) {
          const msg = e?.message ?? String(e)
          // 🔴 只 log 錯誤訊息（Apricot error 無病人資料）— raw response 絕對唔入 log
          console.error(`[backfill-appointments] ${c.name} ${w.month} 失敗：`, msg)
          results.push({ clinic: c.name, clinicId: c.id, month: w.month, error: msg })
          if (msg.includes('AUTH_EXPIRED')) {
            console.error('[backfill-appointments] Apricot 認證失效 —— 中止（重跑安全：upsert 冪等）')
            aborted = true
          }
        }
        if (aborted) break
        await new Promise(r => setTimeout(r, delayMs))
      }
      if (aborted) break
    }
    return { results }
  })

  if (result === null) {
    return { ok: false, skipped: 'another apricot call in progress' }
  }

  const totalAppointments = await prisma.appointmentIndex.count()
  const totalPatients = await prisma.patientIndex.count()
  const elapsedMs = Date.now() - t0
  return { ok: true, start, end, results: result.results, stats: { totalAppointments, totalPatients, elapsedMs } }
}
