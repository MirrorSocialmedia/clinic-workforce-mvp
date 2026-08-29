export const dynamic = 'force-dynamic'
// ============================================================
// GET /api/external/v1/bookable-slots — 可約時段（MD 3.1，scope bookable-slots）
// providerslot-20260830 T1
//
//   Query: clinicCode（必填）& from & to（YYYY-MM-DD）& unitMin=30（只收 30）
//          [&providerId=...]
//   200 { v:1, unitMin, capacityPerProvider, leadTimeMin, generatedAt,
//          days:[{ date, closed, offerableCount, slots:[{ start, end,
//                 providerId, providerName, seatsFree, slotKey }] }] }
//
// 規則（MD §一/§三）：
//   - from < today → 400；to 超 clinic.flowWindowDays → clamp（唔 fail）
//   - closed = 冇醫生當值（roster 三層疊；有當值但無 sync 數據 = closed:false
//     + 0 slots — Flow 只列 closed=false 且 offerableCount>0 嘅日子）
//   - slotKey 不透明簽發（bookable-slot-key.ts）— 碎片唔入 payload
//   - lazy sweep：預約時間已過仍 HELD 自動 RELEASED（fire-and-forget）
// 🔴 PII：response 零病人資料（slots 只有時間/醫生/位數）。
// ============================================================

import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
  isValidDateStr,
  dateDiffDays,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import { todayHK, addDaysStr } from '@/lib/hk-date'
import {
  resolveSlotClinic,
  loadWindowData,
  buildDays,
  hkIsoNow,
  sweepPastHoldsSafe,
} from '@/lib/bookable-slots-service'

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/bookable-slots', async (ctx) => {
    const key = await requireExternalKey(req, 'bookable-slots')
    ctx.setKey(key.name)

    const qp = new URL(req.url).searchParams
    const clinicCode = qp.get('clinicCode')?.trim()
    if (!clinicCode) throw new ExternalApiError(400, 'clinicCode required', 'BAD_REQUEST')
    const clinic = await resolveSlotClinic(clinicCode)

    const from = qp.get('from') ?? ''
    const to = qp.get('to') ?? ''
    if (!isValidDateStr(from)) throw new ExternalApiError(400, 'from (YYYY-MM-DD) required', 'BAD_REQUEST')
    if (!isValidDateStr(to)) throw new ExternalApiError(400, 'to (YYYY-MM-DD) required', 'BAD_REQUEST')
    if (dateDiffDays(from, to) < 0) throw new ExternalApiError(400, 'to must be >= from', 'BAD_REQUEST')
    const today = todayHK()
    if (from < today) throw new ExternalApiError(400, 'from must be today or later', 'BAD_REQUEST')
    // window clamp：Flow 窗口 = clinic.flowWindowDays（today → +N）
    const maxTo = addDaysStr(today, clinic.flowWindowDays)
    const effTo = to > maxTo ? maxTo : to

    const unitRaw = qp.get('unitMin')
    if (unitRaw !== null && unitRaw !== undefined && unitRaw !== '30') {
      throw new ExternalApiError(400, 'unitMin must be 30', 'BAD_REQUEST')
    }
    const providerId = qp.get('providerId')?.trim() || null
    if (providerId && !/^[a-zA-Z0-9_-]{8,64}$/.test(providerId)) {
      throw new ExternalApiError(400, 'providerId invalid', 'BAD_REQUEST')
    }

    // lazy sweep（fire-and-forget — 唔阻 3s SLA）
    sweepPastHoldsSafe(clinic.id)

    const wd = await loadWindowData(clinic, from, effTo, providerId)
    const days = buildDays(clinic, wd)
    return jsonNoStore({
      v: 1,
      unitMin: 30,
      capacityPerProvider: clinic.capacityPerProvider,
      leadTimeMin: clinic.leadTimeMin,
      generatedAt: hkIsoNow(),
      days,
    })
  })
}
