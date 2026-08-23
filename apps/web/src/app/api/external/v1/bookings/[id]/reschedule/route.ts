export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
  isValidDateStr,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import {
  rescheduleBooking,
  mapWriteErrorToExternal,
} from '@/lib/apricot/write-booking'
import {
  requireWriteEnabled,
  requireNewPatientEnabled,
  resolveClinic,
  parsePatient,
  parseSlotFields,
} from '../../guards'

// ============================================================
// POST /api/external/v1/bookings/{apricotApptId}/reschedule
// （MD §5，scope bookings）— cw-apricotwrite-20260823-a1
//
//   Body: { v:1, clinicCode, date（新）, start, durationMin, oldDate（舊單日期）,
//           patient: { patientApricotId } | { name, phone },
//           providerApricotId, visitReasonId?, remarks? }
//
//   200 { v:1, oldApptId, newApptId, dayRefreshed:true, syncedAt }
//   409 SLOT_TAKEN（新時段 clash）｜ 422 NEW_PATIENT_DISABLED
//   503 WRITE_DISABLED ｜ 502 APRICOT_ERROR:{step}
//
// 原子性（MD §3/§6）：同一把 lock 內 102（舊單標記）→ create（新單）。
//   新單 fail → WriteLog ERROR:create_after_102 + alert，**唔自動 rollback**
//   （已知殘留態，人手跟 — 寧願人手都唔好自動亂郁）。
//
// ⚠️ MD 延伸（報告已註記）：MD §5 reschedule body 只寫 { date, start, durationMin }，
//   但 §0 payload 要求新單有病人 + 時段資料、§4 要求 refresh 舊日 cache —
//   故 patient/clinicCode/oldDate/providerApricotId 必填。
// ============================================================

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return withExternalAudit(req, '/api/external/v1/bookings/[id]/reschedule', async (ctx) => {
    const key = await requireExternalKey(req, 'bookings')
    ctx.setKey(key.name)
    requireWriteEnabled()

    const oldApricotApptId = params.id
    if (!oldApricotApptId || oldApricotApptId.length > 128 || /[^\w-]/.test(oldApricotApptId)) {
      throw new ExternalApiError(400, 'invalid apricotApptId', 'BAD_REQUEST')
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      throw new ExternalApiError(400, 'invalid JSON body', 'BAD_REQUEST')
    }
    if (body?.v !== 1) {
      throw new ExternalApiError(400, 'v must be 1', 'BAD_REQUEST')
    }

    const clinicCode = typeof body.clinicCode === 'string' && body.clinicCode.trim()
    if (!clinicCode) {
      throw new ExternalApiError(400, 'clinicCode required', 'BAD_REQUEST')
    }
    const providerApricotId = typeof body.providerApricotId === 'string' && body.providerApricotId.trim()
    if (!providerApricotId) {
      throw new ExternalApiError(400, 'providerApricotId required', 'BAD_REQUEST')
    }
    // 新時段
    const slot = parseSlotFields(body)
    // 舊單日期（refresh 舊日 cache 用）
    const oldDate = typeof body.oldDate === 'string' ? body.oldDate : ''
    if (!isValidDateStr(oldDate)) {
      throw new ExternalApiError(400, 'oldDate (YYYY-MM-DD) required', 'BAD_REQUEST')
    }
    // visitReasonId：選填（唔傳 = 新單唔帶 visit reason — RECONSTRUCTED payload，probe 驗證前保持可选）
    let visitReasonId: string | undefined
    if (body.visitReasonId !== undefined && body.visitReasonId !== null) {
      if (typeof body.visitReasonId !== 'string' || !body.visitReasonId.trim()) {
        throw new ExternalApiError(400, 'visitReasonId must be a non-empty string', 'BAD_REQUEST')
      }
      visitReasonId = body.visitReasonId.trim()
    }
    const remarks =
      body.remarks === undefined ? undefined :
      typeof body.remarks === 'string' ? body.remarks :
      (() => { throw new ExternalApiError(400, 'remarks must be a string', 'BAD_REQUEST') })()
    if (remarks !== undefined && remarks.length > 500) {
      throw new ExternalApiError(400, 'remarks must be <= 500 chars', 'BAD_REQUEST')
    }

    const patient = parsePatient(body.patient)
    requireNewPatientEnabled(patient)
    const clinic = await resolveClinic(clinicCode)

    try {
      const result = await rescheduleBooking({
        oldApricotApptId,
        clinicCuid: clinic.id,
        apricotClinicId: clinic.apricotClinicId,
        providerApricotId,
        oldDateHk: oldDate,
        newDateHk: slot.dateHk,
        newStartHk: slot.startHk,
        newDurationMin: slot.durationMin,
        visitReasonId,
        remarks,
        patient,
        requestedBy: key.name,
      })
      return jsonNoStore({ v: 1, ...result })
    } catch (e) {
      throw mapWriteErrorToExternal(e)
    }
  })
}
