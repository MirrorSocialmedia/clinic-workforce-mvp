export const dynamic = 'force-dynamic'
// ============================================================
// GET /api/external/v1/bookable-slots/held — held PII-free 讀（inbox 警報用）
// providerslot-20260830 T1（MD 交貨 #7 設計決策：獨立 endpoint，唔入
// bookable-slots 主 response — 主 response 3s SLA + Flow 3 秒節奏，警報
// 係低頻路徑，分開先乾淨）
//
//   Query: clinicCode?（唔傳 = 全店）& status?（HELD|IN_APRICOT；預設兩者）
//   200 { v:1, generatedAt, holdTimeoutHours, holds:[{ holdId, date,
//          startMin, endMin, providerId, providerName, status, source,
//          createdAt, ageHours, appointmentPast }] }
//
// 🔴 零病人資料（無 patientWaId/patientName）— T3 警報：
//   HELD ageHours > 12 → MEDIUM；> holdTimeoutHours(24) → HIGH。
// 入火前 lazy sweep：預約時間已過仍 HELD → 自動 RELEASED + audit。
// ============================================================

import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import {
  resolveSlotClinic,
  listHolds,
  hkIsoNow,
} from '@/lib/bookable-slots-service'

const ALLOWED_STATUS = new Set(['HELD', 'IN_APRICOT'])

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/bookable-slots/held', async (ctx) => {
    const key = await requireExternalKey(req, 'bookable-slots')
    ctx.setKey(key.name)

    const qp = new URL(req.url).searchParams
    const clinicCode = qp.get('clinicCode')?.trim()
    const clinic = clinicCode ? await resolveSlotClinic(clinicCode) : null

    const statusRaw = qp.get('status')?.trim().toUpperCase()
    let status: string | null = null
    if (statusRaw !== null && statusRaw !== undefined && statusRaw !== '') {
      if (!ALLOWED_STATUS.has(statusRaw)) {
        throw new ExternalApiError(400, "status must be 'HELD' or 'IN_APRICOT'", 'BAD_REQUEST')
      }
      status = statusRaw
    }

    const holds = await listHolds(clinic, status)
    return jsonNoStore({
      v: 1,
      generatedAt: hkIsoNow(),
      // T3 警報用（12h MEDIUM / 24h HIGH — 數值由 clinic 設定帶出，唔硬編）
      holdTimeoutHours: clinic?.holdTimeoutHours ?? null,
      holds,
    })
  })
}
