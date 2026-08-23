export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
  isValidDateStr,
  dateDiffDays,
} from '@/lib/external-api'
import { STALE_AFTER_MS } from '@/lib/apricot/sync-availability-cache'
import { basePrisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/appointments?phoneHash=&from=&to= — 病人預約列表 API
// （read-chain MD §4.2）— cwc-rdchain-20260823-b1
//
//   Query: phoneHash（必填，64-hex HMAC-SHA256）
//          from / to（YYYY-MM-DD，必填，範圍 ≤ 38 日 —
//          to - from ≤ 37；consumer 標準窗 -7→+30 係整 38 個日曆日）
//   Header: X-Api-Key（scope: appointments — §A.2 守門）
//
//   200: { v:1, syncedAt, stale, appointments:[{ apricotApptId, clinicCode,
//          providerApricotId, providerName, date, start, end, bookingStatus,
//          patientApricotId, patientCode, patientName, visitReasons, remarks }] }
//   404: 無｜400: 格式/範圍錯｜401/403/429: §A.2
//
// 規則：stale = syncedAt 距今 > 30 分鐘（STALE_AFTER_MS — 同 availability 同一規則）。
// bookingStatus 原樣回傳（包含負數取消 — 本 API 係完整預約記錄；
// 「取消唔算到診」嘅過濾只喺 treatment-summary，MD §4.3）。
//
// 🔴 Response 只係白名單 v2：id/code/fullName + visitReasons + remarks。
//    raw phoneNum / HKID / address / medicalHistory 永唔出現（contract test 負面斷言兜底）。
// ============================================================

const PHONE_HASH_RE = /^[0-9a-f]{64}$/i
/** MD §4.2：範圍 ≤ 38 日（含首尾）= to - from ≤ 37 日差 */
const MAX_RANGE_DAY_DIFF = 37

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/appointments', async (ctx) => {
    const key = await requireExternalKey(req, 'appointments')
    ctx.setKey(key.name)

    const params = new URL(req.url).searchParams
    const phoneHash = (params.get('phoneHash') ?? '').trim().toLowerCase()
    const from = params.get('from')
    const to = params.get('to')
    if (!PHONE_HASH_RE.test(phoneHash)) {
      throw new ExternalApiError(400, 'phoneHash required (64-char hex)', 'BAD_REQUEST')
    }
    if (!from || !to || !isValidDateStr(from) || !isValidDateStr(to)) {
      throw new ExternalApiError(400, 'invalid date range', 'BAD_REQUEST')
    }
    const diff = dateDiffDays(from, to)
    if (diff < 0 || diff > MAX_RANGE_DAY_DIFF) {
      throw new ExternalApiError(400, 'date range must be ≤ 38 days (to - from ≤ 37, to >= from)', 'BAD_REQUEST')
    }

    const rows = await basePrisma.appointmentIndex.findMany({
      where: { phoneHash, date: { gte: from, lte: to } },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      select: {
        apricotApptId: true,
        clinicId: true,
        providerApricotId: true,
        providerName: true,
        date: true,
        startTime: true,
        endTime: true,
        bookingStatus: true,
        patientApricotId: true,
        patientCode: true,
        patientName: true,
        visitReasons: true,
        remarks: true,
        syncedAt: true,
      },
    })

    // clinicId → clinicCode（shortName ?? id — 同 availability 同一口徑）
    const clinicIds = [...new Set(rows.map(r => r.clinicId))]
    const clinics = await basePrisma.clinic.findMany({
      where: { id: { in: clinicIds } },
      select: { id: true, shortName: true },
    })
    const clinicCodeById = new Map(clinics.map(c => [c.id, c.shortName ?? c.id]))

    // stale（MD §4.2：同 availability 同一規則 — syncedAt > 30 分鐘）
    let maxSynced: Date | null = null
    for (const r of rows) {
      if (!maxSynced || r.syncedAt > maxSynced) maxSynced = r.syncedAt
    }
    const syncedAt = maxSynced ? maxSynced.toISOString() : null
    const stale = !maxSynced || Date.now() - maxSynced.getTime() > STALE_AFTER_MS

    return jsonNoStore({
      v: 1,
      syncedAt,
      stale,
      appointments: rows.map(r => ({
        apricotApptId: r.apricotApptId,
        clinicCode: clinicCodeById.get(r.clinicId) ?? r.clinicId,
        providerApricotId: r.providerApricotId,
        providerName: r.providerName,
        date: r.date,
        start: r.startTime,
        end: r.endTime,
        bookingStatus: r.bookingStatus,
        patientApricotId: r.patientApricotId,
        patientCode: r.patientCode,
        patientName: r.patientName,
        visitReasons: r.visitReasons,
        remarks: r.remarks,
      })),
    })
  })
}
