// ============================================================
// 夜跑 job — 每晚 03:00（cwi-followup-p1-20260915 — MD §2.3）
//
// 流程：
//   1. clinic-patients/search 掃「昨日」（固定 page size 50 至回空）
//   2. 逐病人 3 call（appointments / consultation-notes / bills，限速 400ms）
//      → upsertVisitIndex()（唯一寫入路徑 — 同手動刷新共用）
//   3. 連帶索引未來 7 日預約（hasNote=false — 供 B 類）
//   4. 重掃過去 7 日 hasNote=false 行（醫生補寫；每行最多重試 7 次 —
//      由 7 日 window 隱性強制：行喺 D 日入窗，D+1..D+7 各重掃，D+8 出窗）
//
// 停止條件：APRICOT_RATE_LIMITED / AUTH → 即刻停（FAILED + lastError）。
// 逐病人其他錯誤 → 記錄後繼續（一晚唔好因一個人死）。
//
// 守門：POST /api/internal/clinical-index-nightly（x-cron-key，同
// sync-availability-history 同一 pattern）。🔴 只回結構統計 — 零病人資料。
// ============================================================

import { basePrisma } from '@/lib/prisma'
import { toHKDateStr, addDaysStr } from '@/lib/hk-date'
import {
  FUTURE_WINDOW_DAYS,
  RESCAN_DAYS,
  type ClinicalCallFn,
} from './types'
import {
  fetchPatientData,
  searchPatientsForDate,
  makeThrottledCallFn,
  isStopNightError,
  getPatientNotes,
} from './apricot-client'
import { resolvePatientDay, upsertVisitIndex, rescanUpdateNote, buildClinicMap } from './visit-index'
import { extractNoteText } from './extract-note-text'

export interface NightlyOutcome {
  status: 'DONE' | 'FAILED'
  stopReason: string | null
  scanDate: string
  patientsFound: number
  patientsProcessed: number
  upserts: number
  rescanned: number
  apiCalls: number
  errors: number
  lastError: string | null
  durationMs: number
}

function errMsg(e: unknown): string {
  return (e as { message?: string })?.message ?? String(e)
}

/** 未來 7 日嘅 appointment HK 日（today < d <= today+7，unique 排序）。 */
function futureDays(appointments: any[], today: string): string[] {
  const max = addDaysStr(today, FUTURE_WINDOW_DAYS)
  const s = new Set<string>()
  for (const a of appointments) {
    const t = a?.conTime ?? a?.checkInTime
    if (typeof t !== 'string' || t.length < 10) continue
    const d = toHKDateStr(t)
    if (d > today && d <= max) s.add(d)
  }
  return [...s].sort()
}

export async function runClinicalIndexNightly(opts: { callFn?: ClinicalCallFn; now?: Date }): Promise<NightlyOutcome> {
  const t0 = Date.now()
  const now = opts.now ?? new Date()
  const today = toHKDateStr(now)
  const yesterday = addDaysStr(today, -1)
  const { call, calls } = makeThrottledCallFn(opts.callFn)
  const phoneKey = process.env.PHONE_HASH_KEY ?? ''
  const clinicMap = await buildClinicMap()

  const outcome: NightlyOutcome = {
    status: 'DONE', stopReason: null, scanDate: yesterday,
    patientsFound: 0, patientsProcessed: 0, upserts: 0, rescanned: 0,
    apiCalls: 0, errors: 0, lastError: null, durationMs: 0,
  }

  const d = (s: string) => new Date(`${s}T00:00:00Z`)
  const job = await basePrisma.clinicalIndexJob.create({
    data: { kind: 'NIGHTLY', rangeFrom: d(yesterday), rangeTo: d(yesterday), status: 'RUNNING', startedAt: new Date() },
  })

  const stop = (reason: string, e: unknown) => {
    outcome.status = 'FAILED'
    outcome.stopReason = reason
    outcome.lastError = errMsg(e)
  }

  try {
    // 1) 掃昨日
    let patients: any[] = []
    try {
      patients = await searchPatientsForDate(call, yesterday)
    } catch (e) {
      if (isStopNightError(e)) stop('APRICOT_UNAVAILABLE', e)
      else stop('SEARCH_FAILED', e)
    }
    outcome.patientsFound = patients.length

    // 2) 逐病人 3 call + upsert（含未來 7 日）
    for (const p of patients) {
      if (outcome.status !== 'DONE') break
      try {
        const data = await fetchPatientData(call, p.cpId ?? p.id, yesterday)
        const v = resolvePatientDay({ patient: p, ...data, day: yesterday, clinicMap, phoneKey })
        if (v) { await upsertVisitIndex(v); outcome.upserts++ }
        // 3) 未來 7 日（B 類）— notes/bills 唔計（hasNote=false、bill null）
        for (const fd of futureDays(data.appointments, today)) {
          const fv = resolvePatientDay({ patient: p, appointments: data.appointments, notes: [], bills: [], day: fd, clinicMap, phoneKey })
          if (fv) { await upsertVisitIndex(fv); outcome.upserts++ }
        }
        outcome.patientsProcessed++
      } catch (e) {
        if (isStopNightError(e)) { stop('APRICOT_UNAVAILABLE', e); break }
        outcome.errors++
        outcome.lastError = errMsg(e)
      }
    }

    // 4) 重掃過去 7 日 hasNote=false（只更新 note 欄 — MD §2.3）
    if (outcome.status === 'DONE') {
      const rows = await basePrisma.clinicalRecordIndex.findMany({
        where: {
          visitDate: { gte: d(addDaysStr(today, -RESCAN_DAYS)), lt: d(today) },
          hasNote: false,
          apricotApptId: { not: null },
        },
        select: { id: true, patientApricotId: true, apricotApptId: true },
      })
      const byPatient = new Map<string, typeof rows>()
      for (const r of rows) {
        const arr = byPatient.get(r.patientApricotId) ?? []
        arr.push(r)
        byPatient.set(r.patientApricotId, arr)
      }
      for (const [cpId, patientRows] of byPatient) {
        if (outcome.status !== 'DONE') break
        try {
          const notes = await getPatientNotes(call, cpId)
          for (const r of patientRows) {
            const note = notes.find((n: any) => n?.bookingId === r.apricotApptId)
            if (!note) continue
            const nt = extractNoteText(note)
            await rescanUpdateNote(r.id, { apricotNoteId: typeof note.id === 'string' ? note.id : null, noteKind: nt.kind, noteJson: nt })
            outcome.rescanned++
          }
        } catch (e) {
          if (isStopNightError(e)) { stop('APRICOT_UNAVAILABLE', e); break }
          outcome.errors++
          outcome.lastError = errMsg(e)
        }
      }
    }
  } finally {
    outcome.apiCalls = calls()
    outcome.durationMs = Date.now() - t0
    await basePrisma.clinicalIndexJob.update({
      where: { id: job.id },
      data: {
        status: outcome.status,
        patients: outcome.patientsProcessed,
        apiCalls: outcome.apiCalls,
        errors: outcome.errors,
        lastError: outcome.lastError,
        finishedAt: new Date(),
      },
    })
  }
  return outcome
}
