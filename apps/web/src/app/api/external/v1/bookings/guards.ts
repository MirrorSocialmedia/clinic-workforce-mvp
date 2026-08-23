// ============================================================
// /v1/bookings 共用守門（MD §5，scope bookings）— cw-apricotwrite-20260823-a1
//
// 所有寫入 route 共同嘅入路守門：
//   1) APRICOT_WRITE 總閘（off → 503 WRITE_DISABLED）
//   2) ALLOW_NEW_PATIENT_WRITE（新客 inline → off 時 422 NEW_PATIENT_DISABLED）
//   3) clinic 解析（shortName 或 cuid；無 apricotClinicId → 400）
//   4) 日期/時段驗證（HK 日界；today → +30 窗口；唔準跨日）
//
// 🔴 PII：patient name/phone 只流向 Apricot payload — error message/response/
//    audit 零回顯（呢度所有 400 message 都唔含病人值）。
// ============================================================

import { NextRequest } from 'next/server'
import { ExternalApiError, isValidDateStr } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { todayHK, addDaysStr } from '@/lib/hk-date'
import {
  isApricotWriteEnabled,
  isNewPatientWriteEnabled,
  addMinutesHhmm,
} from '@/lib/apricot/write-booking'
import type { PatientRef } from '@/lib/apricot/write-booking'

/** 落單窗口 = AvailabilityCache 窗口（today → +30 日）— 超窗 cache 無從反映 */
export const BOOKING_WINDOW_DAYS = 30

/** 總閘：APRICOT_WRITE off → 503 WRITE_DISABLED（MD §5） */
export function requireWriteEnabled(): void {
  if (!isApricotWriteEnabled()) {
    throw new ExternalApiError(503, 'apricot write disabled', 'WRITE_DISABLED')
  }
}

/** 新客 inline body 守門：ALLOW_NEW_PATIENT_WRITE off → 422（第一階段 off） */
export function requireNewPatientEnabled(patient: PatientRef): void {
  if (!('apricotId' in patient) && !isNewPatientWriteEnabled()) {
    throw new ExternalApiError(422, 'new patient write disabled', 'NEW_PATIENT_DISABLED')
  }
}

export interface ClinicRef {
  id: string
  shortName: string | null
  apricotClinicId: string
}

/** clinicCode = shortName（旺/仁/銅）或 cuid — 同 /v1/availability 口徑 */
export async function resolveClinic(clinicCode: string): Promise<ClinicRef> {
  const clinic = await basePrisma.clinic.findFirst({
    where: { OR: [{ shortName: clinicCode }, { id: clinicCode }] },
    select: { id: true, shortName: true, apricotClinicId: true },
  })
  if (!clinic) {
    throw new ExternalApiError(404, 'clinic not found', 'CLINIC_NOT_FOUND')
  }
  const apricotClinicId = clinic.apricotClinicId
  if (!apricotClinicId) {
    throw new ExternalApiError(400, 'clinic has no Apricot mapping', 'BAD_REQUEST')
  }
  return { id: clinic.id, shortName: clinic.shortName, apricotClinicId }
}

/**
 * patient object 驗證：exactly one of
 *   { patientApricotId }（舊客）｜{ name, phone }（新客）
 * 🔴 message 唔含病人值。
 */
export function parsePatient(raw: unknown): PatientRef {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ExternalApiError(400, 'patient object required', 'BAD_REQUEST')
  }
  const p = raw as Record<string, unknown>
  const apricotId = typeof p.patientApricotId === 'string' && p.patientApricotId.trim() ? p.patientApricotId.trim() : null
  const name = typeof p.name === 'string' ? p.name.trim() : null
  const phone = typeof p.phone === 'string' ? p.phone.trim() : null

  if (apricotId && (name || phone)) {
    throw new ExternalApiError(400, 'patient: exactly one of patientApricotId or (name+phone)', 'BAD_REQUEST')
  }
  if (apricotId) {
    if (apricotId.length > 128) throw new ExternalApiError(400, 'patientApricotId too long', 'BAD_REQUEST')
    return { apricotId }
  }
  if (name && phone) {
    if (name.length > 100) throw new ExternalApiError(400, 'patient.name must be 1-100 chars', 'BAD_REQUEST')
    if (phone.length < 5 || phone.length > 20) throw new ExternalApiError(400, 'patient.phone must be 5-20 chars', 'BAD_REQUEST')
    return { name, phone }
  }
  throw new ExternalApiError(400, 'patient: exactly one of patientApricotId or (name+phone)', 'BAD_REQUEST')
}

/** 寫入 request 嘅時段字段驗證（create / reschedule 共用） */
export interface SlotFields {
  dateHk: string
  startHk: string
  durationMin: number
}

export function parseSlotFields(body: Record<string, unknown>): SlotFields {
  const date = body.date
  if (typeof date !== 'string' || !isValidDateStr(date)) {
    throw new ExternalApiError(400, 'date (YYYY-MM-DD) required', 'BAD_REQUEST')
  }
  const today = todayHK()
  const maxDate = addDaysStr(today, BOOKING_WINDOW_DAYS)
  if (date < today) throw new ExternalApiError(400, 'date must be today or later', 'BAD_REQUEST')
  if (date > maxDate) throw new ExternalApiError(400, `date beyond ${BOOKING_WINDOW_DAYS}-day window`, 'BAD_REQUEST')

  const start = body.start
  if (typeof start !== 'string' || !/^\d{2}:\d{2}$/.test(start) || Number(start.slice(3)) > 59) {
    throw new ExternalApiError(400, 'start (HH:mm) required', 'BAD_REQUEST')
  }
  const durationMin = body.durationMin
  if (typeof durationMin !== 'number' || !Number.isInteger(durationMin) || durationMin < 1 || durationMin > 480) {
    throw new ExternalApiError(400, 'durationMin (integer 1-480) required', 'BAD_REQUEST')
  }
  if (!addMinutesHhmm(start, durationMin)) {
    throw new ExternalApiError(400, 'booking must not cross midnight', 'BAD_REQUEST')
  }
  return { dateHk: date, startHk: start, durationMin }
}

/**
 * status/remove 共用 query：date（單嘅 HK 日期 — single-day sync 用，consumer 傳入）
 * + clinicCode。
 *
 * ⚠️ MD 延伸（報告已註記）：MD §5 route 簽名冇 date/clinicCode 參數，但 §4 要求
 *    每個寫動作成功後做 single-day sync — 需要該單嘅日期 + 店。consumer
 *    （wa-inbox）落單時已知，直接傳入。
 */
export async function parseMutationQuery(req: NextRequest): Promise<{ dateHk: string; clinic: ClinicRef }> {
  const qp = new URL(req.url).searchParams
  const date = qp.get('date')
  if (!date || !isValidDateStr(date)) {
    throw new ExternalApiError(400, 'date (YYYY-MM-DD) required', 'BAD_REQUEST')
  }
  const clinicCode = qp.get('clinicCode')
  if (!clinicCode) {
    throw new ExternalApiError(400, 'clinicCode required', 'BAD_REQUEST')
  }
  const clinic = await resolveClinic(clinicCode)
  return { dateHk: date, clinic }
}
