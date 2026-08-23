export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import {
  createBooking,
  mapWriteErrorToExternal,
} from '@/lib/apricot/write-booking'
import {
  requireWriteEnabled,
  requireNewPatientEnabled,
  resolveClinic,
  parsePatient,
  parseSlotFields,
} from './guards'

// ============================================================
// POST /api/external/v1/bookings — 代病人落單（MD §5，scope bookings）
// cw-apricotwrite-20260823-a1
//
//   Body: { v:1, idempotencyKey, clinicCode, providerApricotId,
//           date, start, durationMin, visitReasonId, remarks?,
//           patient: { patientApricotId } | { name, phone } }
//   Header: X-Api-Key（scope: bookings — §A.2 守門）
//
//   200 { v:1, apricotApptId, bookingStatus:0, patientApricotId, patientCode,
//         dayRefreshed:true, syncedAt }
//   409 SLOT_TAKEN ｜ 422 NEW_PATIENT_DISABLED ｜ 503 WRITE_DISABLED
//   502 APRICOT_ERROR:{step} ｜ 503 APRICOT_BUSY（lock busy — 可稍後重試）
//
// 冪等鐵律：同 idempotencyKey 重放 → 同 apricotApptId（replayed，無新寫入），
//   唔會重複落單（MD §6 驗收項，contract test 釘住）。
// 🔴 PII：patient name/phone 只入 Apricot payload — response/audit/log 零回顯。
// ============================================================

export async function POST(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/bookings', async (ctx) => {
    const key = await requireExternalKey(req, 'bookings')
    ctx.setKey(key.name)

    // 兩 flags 守門（MD §5）：總閘先，後新客
    requireWriteEnabled()

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      throw new ExternalApiError(400, 'invalid JSON body', 'BAD_REQUEST')
    }
    if (body?.v !== 1) {
      throw new ExternalApiError(400, 'v must be 1', 'BAD_REQUEST')
    }

    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new ExternalApiError(400, 'idempotencyKey required (8-128 chars)', 'BAD_REQUEST')
    }
    const clinicCode = typeof body.clinicCode === 'string' && body.clinicCode.trim()
    if (!clinicCode) {
      throw new ExternalApiError(400, 'clinicCode required', 'BAD_REQUEST')
    }
    const providerApricotId = typeof body.providerApricotId === 'string' && body.providerApricotId.trim()
    if (!providerApricotId) {
      throw new ExternalApiError(400, 'providerApricotId required', 'BAD_REQUEST')
    }
    const slot = parseSlotFields(body)
    const visitReasonId = typeof body.visitReasonId === 'string' && body.visitReasonId.trim()
    if (!visitReasonId || visitReasonId.length > 64) {
      throw new ExternalApiError(400, 'visitReasonId required (<= 64 chars)', 'BAD_REQUEST')
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
      const result = await createBooking({
        idempotencyKey,
        clinicCuid: clinic.id,
        apricotClinicId: clinic.apricotClinicId,
        providerApricotId,
        dateHk: slot.dateHk,
        startHk: slot.startHk,
        durationMin: slot.durationMin,
        visitReasonId,
        remarks,
        patient,
        requestedBy: key.name,
      })
      // 舊客：response 未必回 patient id → fallback 傳入值；新客：取自 create response
      const patientApricotId =
        result.patientApricotId ?? ('apricotId' in patient ? patient.apricotId : null)
      return jsonNoStore({
        v: 1,
        apricotApptId: result.apricotApptId,
        bookingStatus: 0,
        patientApricotId,
        patientCode: result.patientCode,
        dayRefreshed: result.dayRefreshed,
        syncedAt: result.syncedAt,
      })
    } catch (e) {
      throw mapWriteErrorToExternal(e)
    }
  })
}
