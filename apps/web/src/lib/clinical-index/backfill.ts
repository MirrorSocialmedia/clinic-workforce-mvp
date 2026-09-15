// ============================================================
// 回填（一次性，365 日 / 4 晚）— cwi-followup-p1-20260915 — MD §2.5
//
// 每晚跑一段（default 90 日）：逐日 clinic-patients/search（固定 size 50）
// → 逐病人 3 call → upsertVisitIndex()（同夜跑同一寫入路徑）。
//
// 護欄（MD §2.5）：
//   - maxCalls = 30,000（計所有 Apricot call，含 search page）
//   - maxHours = 4（wall clock）
//   - 任何 APRICOT_RATE_LIMITED → 即刻停當晚，第二晚由 cursor 續
//   - cursorDate = 下一個未處理日；中斷嗰日下次整日重跑（upsert 冪等）
//
// 🔴 回填限制（要寫入 UI 說明 — 見 docs/clinical-index-backfill.md）：
//    lastVisitDate 篩選只回「最後一次到訪 = 嗰日」嘅病人 → 回填唔會攞齊
//    所有歷史到訪，只會攞到每個病人最後一次到訪嘅記錄。D 類召回啱啱好
//    就要呢個；「某病人一年內所有到訪」唔完整。
// ============================================================

import { basePrisma } from '@/lib/prisma'
import { toHKDateStr, addDaysStr } from '@/lib/hk-date'
import {
  BACKFILL_DAYS_PER_RUN,
  BACKFILL_MAX_CALLS,
  BACKFILL_MAX_HOURS,
  BACKFILL_RANGE_DAYS,
  type ClinicalCallFn,
} from './types'
import { fetchPatientData, searchPatientsForDate, makeThrottledCallFn, isStopNightError } from './apricot-client'
import { resolvePatientDay, upsertVisitIndex, buildClinicMap } from './visit-index'

export type BackfillPauseReason = 'PAUSED_CALLS' | 'PAUSED_HOURS' | 'PAUSED_RATE_LIMITED' | 'PAUSED_QUOTA' | 'FAILED'

export interface BackfillOutcome {
  /** DONE = 365 日跑完；其餘 = 今晚停咗（cursor 已存，第二晚續） */
  status: 'DONE' | BackfillPauseReason
  cursorDate: string | null
  processedDays: number
  patients: number
  upserts: number
  apiCalls: number
  errors: number
  lastError: string | null
  durationMs: number
}

function errMsg(e: unknown): string {
  return (e as { message?: string })?.message ?? String(e)
}
const d = (s: string) => new Date(`${s}T00:00:00Z`)
/** YYYY-MM-DD 字典序 = 時間序。 */
const minDateStr = (a: string, b: string) => (a < b ? a : b)

export async function runClinicalIndexBackfill(opts: {
  callFn?: ClinicalCallFn
  now?: Date
  maxCalls?: number
  maxHours?: number
  daysPerRun?: number
}): Promise<BackfillOutcome> {
  const t0 = Date.now()
  const now = opts.now ?? new Date()
  const today = toHKDateStr(now)
  const rangeTo = addDaysStr(today, -1)
  const maxCalls = opts.maxCalls ?? BACKFILL_MAX_CALLS
  const maxMs = (opts.maxHours ?? BACKFILL_MAX_HOURS) * 3_600_000
  const daysPerRun = opts.daysPerRun ?? BACKFILL_DAYS_PER_RUN

  const outcome: BackfillOutcome = {
    status: 'DONE', cursorDate: null, processedDays: 0, patients: 0,
    upserts: 0, apiCalls: 0, errors: 0, lastError: null, durationMs: 0,
  }

  // Job 行（首次跑 create：rangeFrom = 首次嘅 today-365；之後續跑用既有行）
  let job = await basePrisma.clinicalIndexJob.findFirst({
    where: { kind: 'BACKFILL', status: { in: ['PENDING', 'RUNNING'] } },
  })
  if (!job) {
    job = await basePrisma.clinicalIndexJob.create({
      data: {
        kind: 'BACKFILL',
        rangeFrom: d(addDaysStr(today, -BACKFILL_RANGE_DAYS)),
        rangeTo: d(rangeTo),
        status: 'RUNNING',
        startedAt: new Date(),
      },
    })
  }
  const rangeFrom = toHKDateStr(job.rangeFrom)
  const jobRangeTo = toHKDateStr(job.rangeTo)
  let cursor = toHKDateStr(job.cursorDate ?? job.rangeFrom)
  const end = minDateStr(addDaysStr(cursor, daysPerRun - 1), jobRangeTo)

  const { call, calls } = makeThrottledCallFn(opts.callFn)
  const phoneKey = process.env.PHONE_HASH_KEY ?? ''
  const clinicMap = await buildClinicMap()

  const pause = (reason: BackfillPauseReason, lastError: string | null = null) => {
    outcome.status = reason
    if (lastError) outcome.lastError = lastError
  }

  try {
    for (let day = cursor; day <= end; day = addDaysStr(day, 1)) {
      // 護欄 1：maxCalls / 護欄 2：maxHours（MD §2.5）
      if (calls() >= maxCalls) { pause('PAUSED_CALLS'); break }
      if (Date.now() - t0 >= maxMs) { pause('PAUSED_HOURS'); break }

      let dayPatients: any[]
      try {
        dayPatients = await searchPatientsForDate(call, day)
      } catch (e) {
        if (isStopNightError(e)) { pause('PAUSED_RATE_LIMITED', errMsg(e)); break }
        // 其他 search 錯 → 停當晚（cursor 唔前進 — 第二晚重試呢日）
        pause('FAILED', errMsg(e))
        break
      }

      let midDayStop = false
      for (const p of dayPatients) {
        if (calls() >= maxCalls) { pause('PAUSED_CALLS'); midDayStop = true; break }
        if (Date.now() - t0 >= maxMs) { pause('PAUSED_HOURS'); midDayStop = true; break }
        try {
          const data = await fetchPatientData(call, p.cpId ?? p.id, day)
          const v = resolvePatientDay({ patient: p, ...data, day, clinicMap, phoneKey })
          if (v) { await upsertVisitIndex(v); outcome.upserts++ }
          outcome.patients++
        } catch (e) {
          if (isStopNightError(e)) { pause('PAUSED_RATE_LIMITED', errMsg(e)); midDayStop = true; break }
          outcome.errors++
          outcome.lastError = errMsg(e)
        }
      }
      if (midDayStop) break

      // 整日完成 → cursor 前進（每日落 DB — 中斷可續）
      outcome.processedDays++
      cursor = addDaysStr(day, 1)
      await basePrisma.clinicalIndexJob.update({
        where: { id: job.id },
        data: {
          cursorDate: d(cursor),
          patients: job.patients + outcome.patients,
          apiCalls: calls(),
          errors: job.errors + outcome.errors,
          lastError: outcome.lastError,
        },
      })
    }

    const exhausted = cursor > jobRangeTo
    if (exhausted) {
      outcome.status = 'DONE'
      outcome.cursorDate = null
    } else if (outcome.status === 'DONE') {
      // 當晚 quota（daysPerRun）跑完但範圍未完 — 正常停（第二晚 cron 續）
      outcome.status = 'PAUSED_QUOTA'
      outcome.cursorDate = cursor
    } else {
      outcome.cursorDate = cursor
    }
  } finally {
    outcome.apiCalls = calls()
    outcome.durationMs = Date.now() - t0
    const done = outcome.status === 'DONE'
    await basePrisma.clinicalIndexJob.update({
      where: { id: job.id },
      data: {
        status: done ? 'DONE' : 'RUNNING', // 停咗 = 照 RUNNING，第二晚 cron 續
        cursorDate: outcome.cursorDate ? d(outcome.cursorDate) : null,
        patients: job.patients + outcome.patients,
        apiCalls: calls(),
        errors: job.errors + outcome.errors,
        lastError: done ? null : (outcome.lastError ?? outcome.status),
        finishedAt: done ? new Date() : null,
      },
    })
  }
  return outcome
}
