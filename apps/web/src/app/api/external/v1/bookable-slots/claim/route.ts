export const dynamic = 'force-dynamic'
// ============================================================
// POST /api/external/v1/bookable-slots/claim — 佔位硬保留（MD 3.2）
// providerslot-20260830 T1
//
//   Body: { v:1, slotKey, patient:{waId,name?}, source, flowToken,
//           visitReasonId? }
//   Header: X-Api-Key（scope bookable-slots）, Idempotency-Key = flowToken
//
//   201 { v:1, holdId, start, end, date, providerName, expiresAt:null }
//   409 { v:1, error:"slot_taken", alternatives:[…] }（最新 2-3 個可出位）
//   409 { v:1, error:"flow_token_reused" }（同 token 唔同 slot）
//
// 冪等鐵律：同 flowToken 重放 → 同 holdId（Meta 重試唔佔兩個位）。
// 單一交易：交易內重算 offerable → 插 hold（partial unique index 兜 race）。
// APRICOT_WRITE=1 → createBooking 成功 IN_APRICOT / 失敗留 HELD（MD §四）。
// 🔴 PII：patient 只入 ProviderHold + Apricot payload — response 零回顯。
// ============================================================

import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import { minToHHmm } from '@/lib/bookable-slots'
import {
  claimSlot,
  computeAlternatives,
  resolveSlotClinic,
  SlotTakenError,
} from '@/lib/bookable-slots-service'

const ALLOWED_SOURCES = new Set(['whatsapp_flow', 'staff'])

export async function POST(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/bookable-slots/claim', async (ctx) => {
    const key = await requireExternalKey(req, 'bookable-slots')
    ctx.setKey(key.name)

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      throw new ExternalApiError(400, 'invalid JSON body', 'BAD_REQUEST')
    }
    if (body?.v !== 1) throw new ExternalApiError(400, 'v must be 1', 'BAD_REQUEST')

    const slotKey = typeof body.slotKey === 'string' ? body.slotKey.trim() : ''
    if (slotKey.length < 8 || slotKey.length > 512) {
      throw new ExternalApiError(400, 'slotKey required', 'BAD_REQUEST')
    }

    const patient = body.patient
    if (typeof patient !== 'object' || patient === null || Array.isArray(patient)) {
      throw new ExternalApiError(400, 'patient object required', 'BAD_REQUEST')
    }
    const p = patient as Record<string, unknown>
    const waId = typeof p.waId === 'string' ? p.waId.trim() : ''
    if (waId.length < 5 || waId.length > 20) {
      throw new ExternalApiError(400, 'patient.waId must be 5-20 chars', 'BAD_REQUEST')
    }
    const nameRaw = p.name
    const patientName =
      nameRaw === undefined || nameRaw === null
        ? null
        : typeof nameRaw === 'string' && nameRaw.trim()
          ? nameRaw.trim().slice(0, 100)
          : (() => { throw new ExternalApiError(400, 'patient.name must be a string', 'BAD_REQUEST') })()

    const source = typeof body.source === 'string' ? body.source.trim() : ''
    if (!ALLOWED_SOURCES.has(source)) {
      throw new ExternalApiError(400, "source must be 'whatsapp_flow' or 'staff'", 'BAD_REQUEST')
    }

    const flowToken = typeof body.flowToken === 'string' ? body.flowToken.trim() : ''
    if (flowToken.length < 8 || flowToken.length > 128) {
      throw new ExternalApiError(400, 'flowToken required (8-128 chars)', 'BAD_REQUEST')
    }
    // Idempotency-Key header 必須 = flowToken（MD 3.2）
    const idemHeader = req.headers.get('idempotency-key')?.trim() ?? ''
    if (idemHeader !== flowToken) {
      throw new ExternalApiError(400, 'Idempotency-Key header must equal flowToken', 'BAD_REQUEST')
    }

    const visitReasonIdRaw = body.visitReasonId
    const visitReasonId =
      visitReasonIdRaw === undefined || visitReasonIdRaw === null
        ? null
        : typeof visitReasonIdRaw === 'string' && visitReasonIdRaw.trim()
          ? visitReasonIdRaw.trim()
          : (() => { throw new ExternalApiError(400, 'visitReasonId must be a string', 'BAD_REQUEST') })()
    if (visitReasonId !== null && visitReasonId.length > 64) {
      throw new ExternalApiError(400, 'visitReasonId must be <= 64 chars', 'BAD_REQUEST')
    }

    try {
      const result = await claimSlot({
        slotKey,
        patientWaId: waId,
        patientName,
        source,
        flowToken,
        visitReasonId,
        requestedBy: key.name,
      })
      // 🔴 response 零病人資料
      return jsonNoStore(
        {
          v: 1,
          holdId: result.hold.id,
          start: minToHHmm(result.hold.startMin),
          end: minToHHmm(result.hold.endMin),
          date: result.hold.date,
          providerName: result.hold.providerName,
          expiresAt: null,
        },
        { status: 201 },
      )
    } catch (e) {
      if (e instanceof SlotTakenError) {
        const clinic = await resolveSlotClinic(e.context.clinicCode)
        const alternatives = await computeAlternatives(
          clinic,
          e.context.providerId,
          e.context.date,
          e.context.startMin,
        )
        return jsonNoStore({ v: 1, error: 'slot_taken', alternatives }, { status: 409 })
      }
      throw e
    }
  })
}
