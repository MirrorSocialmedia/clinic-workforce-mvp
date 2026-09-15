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
// GET /api/external/v1/appointments — 病人預約列表 API
// （read-chain MD §4.2）— cwc-rdchain-20260823-b1
// ＋ cwi-followup-p1-20260915（MD §2.6 #3）：新增 clinicCode 模式（B 類）
//
//   模式 A（現有，保留）：phoneHash（必填，64-hex HMAC-SHA256）+ from/to（≤38 日）
//   模式 B（新增）：clinicCode + from/to（≤38 日）— 該診所該窗全部預約，
//                   每行加 phoneHashes[]（ClinicalRecordIndex 同日行；無行
//                   就 fallback [legacy phoneHash]）
//   兩模式唔同時提供；phoneHash 優先（同傳 → 400）。
//   Header: X-Api-Key（scope: appointments — §A.2 守門）
//
//   200: { v:1, syncedAt, stale, appointments:[{ apricotApptId, clinicCode,
//          providerApricotId, providerName, date, start, end, bookingStatus,
//          patientApricotId, patientCode, patientName, visitReasons, remarks,
//          phoneHashes? }] }   ← phoneHashes 只係模式 B 有
//   404: 無｜400: 格式/範圍錯｜401/403/429: §A.2
//
// 規則：stale = syncedAt 距今 > 30 分鐘（STALE_AFTER_MS — 同 availability 同一規則）。
// bookingStatus 原樣回傳（包含負數取消/爽約 -3 — 完整預約記錄）。
//
// 🔴 Response 只係白名單 v2：id/code/fullName + visitReasons + remarks +
//    phoneHashes[]。raw phoneNum / HKID / address / medicalHistory 永唔出現
//    （contract test 負面斷言兜底）。
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
    const clinicCodeRaw = (params.get('clinicCode') ?? '').trim()
    const from = params.get('from')
    const to = params.get('to')
    const phoneHashMode = !!phoneHash
    const clinicMode = !!clinicCodeRaw
    if (phoneHashMode && clinicMode) {
      throw new ExternalApiError(400, 'phoneHash and clinicCode are mutually exclusive', 'BAD_REQUEST')
    }
    if (!phoneHashMode && !clinicMode) {
      throw new ExternalApiError(400, 'phoneHash or clinicCode required', 'BAD_REQUEST')
    }
    if (!from || !to || !isValidDateStr(from) || !isValidDateStr(to)) {
      throw new ExternalApiError(400, 'invalid date range', 'BAD_REQUEST')
    }
    const diff = dateDiffDays(from, to)
    if (diff < 0 || diff > MAX_RANGE_DAY_DIFF) {
      throw new ExternalApiError(400, 'date range must be ≤ 38 days (to - from ≤ 37, to >= from)', 'BAD_REQUEST')
    }

    // clinicCode → clinic（shortName ?? id 口徑；同 availability）
    let clinicId: string | null = null
    if (clinicMode) {
      const clinic = await basePrisma.clinic.findFirst({
        where: { OR: [{ shortName: clinicCodeRaw }, { id: clinicCodeRaw }] },
        select: { id: true },
      })
      if (!clinic) throw new ExternalApiError(404, 'clinic not found', 'NOT_FOUND')
      clinicId = clinic.id
    }

    const rows = phoneHashMode
      ? await basePrisma.appointmentIndex.findMany({
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
            phoneHash: true,
            syncedAt: true,
          },
        })
      : await basePrisma.appointmentIndex.findMany({
          where: { clinicId: clinicId!, date: { gte: from, lte: to } },
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
            phoneHash: true,
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

    // 模式 B：phoneHashes[]（ClinicalRecordIndex 同病人同日行嘅 hash union；
    // 無行 → fallback [legacy phoneHash]）。模式 A 唔加（P0 回應形狀保留）。
    let hashesByPatientDate: Map<string, string[]> | null = null
    if (clinicMode) {
      const key2 = (r: { patientApricotId: string; date: string }) => `${r.patientApricotId}|${r.date}`
      const wanted = new Set(rows.map(r => key2(r)))
      if (wanted.size) {
        const idx = await basePrisma.clinicalRecordIndex.findMany({
          where: {
            clinicId: clinicId!,
            visitDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
          },
          select: { patientApricotId: true, visitDate: true, phoneHashes: true },
        })
        const m = new Map<string, Set<string>>()
        for (const r of idx) {
          const k = `${r.patientApricotId}|${r.visitDate.toISOString().slice(0, 10)}`
          if (!wanted.has(k)) continue
          const s = m.get(k) ?? new Set<string>()
          for (const h of r.phoneHashes) s.add(h)
          m.set(k, s)
        }
        hashesByPatientDate = new Map([...m.entries()].map(([k, s]) => [k, [...s]]))
      }
    }

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
        ...(clinicMode
          ? { phoneHashes: (hashesByPatientDate?.get(`${r.patientApricotId}|${r.date}`)?.length ?? 0) > 0
              ? hashesByPatientDate!.get(`${r.patientApricotId}|${r.date}`)!
              : [r.phoneHash] }
          : {}),
      })),
    })
  })
}
