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
import { addDaysStr } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/availability — 醫生空檔 API（MD §C.1 契約）
// cw-extapi-20260823-a1
//
//   Query: clinicCode（必填，店代號如 旺/仁/銅，亦接受 clinic cuid）
//          providerApricotId（選填，唔傳 = 該店全部醫生）
//          from / to（YYYY-MM-DD，必填，to - from ≤ 31 日）
//   Header: X-Api-Key（scope: availability — §A.2 守門）
//
//   200: { v:1, clinicCode, syncedAt, stale, days:[{ date, providers:[
//           { providerApricotId, providerName, slots:[{ start, end, isOpen, bookedCount }] }
//         ] }] }
//   404: { error, code:'CLINIC_NOT_FOUND' }｜400: 格式/範圍錯｜401/403/429: §A.2
//
// 規則：stale = syncedAt 距今 > 30 分鐘（STALE_AFTER_MS）。
// 🔴 Response 內永不出現任何病人資料 — 數據源 AvailabilityCache 本身零 PII
//    （sync 端 sanitize 白名單 + assertNoPii），contract test 有負面斷言兜底。
//
// 契約註記：days 包含 from..to 全部日曆日（無數據日 providers: []）—
// 俾 calendar 渲染有確定性形狀。
// ============================================================

const MAX_RANGE_DAYS = 31

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/availability', async (ctx) => {
    const key = await requireExternalKey(req, 'availability')
    ctx.setKey(key.name)

    const params = new URL(req.url).searchParams
    const clinicCode = params.get('clinicCode')
    if (!clinicCode) {
      throw new ExternalApiError(400, 'clinicCode required', 'BAD_REQUEST')
    }
    const providerApricotId = params.get('providerApricotId')
    const from = params.get('from')
    const to = params.get('to')
    if (!from || !to || !isValidDateStr(from) || !isValidDateStr(to)) {
      throw new ExternalApiError(400, 'invalid date range', 'BAD_REQUEST')
    }
    const diff = dateDiffDays(from, to)
    if (diff < 0 || diff > MAX_RANGE_DAYS) {
      throw new ExternalApiError(400, 'date range must be 0-31 days (to >= from)', 'BAD_REQUEST')
    }

    const clinic = await basePrisma.clinic.findFirst({
      where: { OR: [{ shortName: clinicCode }, { id: clinicCode }] },
      select: { id: true, shortName: true },
    })
    if (!clinic) {
      throw new ExternalApiError(404, 'clinic not found', 'CLINIC_NOT_FOUND')
    }

    const rows = await basePrisma.availabilityCache.findMany({
      where: {
        clinicId: clinic.id,
        date: { gte: from, lte: to },
        ...(providerApricotId ? { providerApricotId } : {}),
      },
      select: {
        providerApricotId: true,
        providerName: true,
        date: true,
        startTime: true,
        endTime: true,
        isOpen: true,
        bookedCount: true,
        syncedAt: true,
      },
    })

    // 分組：date → providerApricotId → slots（startTime 排序）
    const byDate = new Map<string, Map<string, { name: string; slots: { start: string; end: string; isOpen: boolean; bookedCount: number }[] }>>()
    for (const r of rows) {
      let day = byDate.get(r.date)
      if (!day) {
        day = new Map()
        byDate.set(r.date, day)
      }
      let provider = day.get(r.providerApricotId)
      if (!provider) {
        provider = { name: r.providerName, slots: [] }
        day.set(r.providerApricotId, provider)
      }
      provider.slots.push({ start: r.startTime, end: r.endTime, isOpen: r.isOpen, bookedCount: r.bookedCount })
    }

    const days: { date: string; providers: { providerApricotId: string; providerName: string; slots: { start: string; end: string; isOpen: boolean; bookedCount: number }[] }[] }[] = []
    for (let d = from; d <= to; d = addDaysStr(d, 1)) {
      const dayMap = byDate.get(d)
      days.push({
        date: d,
        providers: dayMap
          ? [...dayMap.entries()].map(([apricotId, p]) => ({
              providerApricotId: apricotId,
              providerName: p.name,
              slots: p.slots.sort((a, b) => a.start.localeCompare(b.start)),
            }))
          : [],
      })
    }

    // stale 邏輯（MD §C.1）：stale = syncedAt 距今 > 30 分鐘
    let maxSynced: Date | null = null
    for (const r of rows) {
      if (!maxSynced || r.syncedAt > maxSynced) maxSynced = r.syncedAt
    }
    const syncedAt = maxSynced ? maxSynced.toISOString() : null
    const stale = !maxSynced || Date.now() - maxSynced.getTime() > STALE_AFTER_MS

    return jsonNoStore({
      v: 1,
      clinicCode: clinic.shortName ?? clinic.id,
      syncedAt,
      stale,
      days,
    })
  })
}
