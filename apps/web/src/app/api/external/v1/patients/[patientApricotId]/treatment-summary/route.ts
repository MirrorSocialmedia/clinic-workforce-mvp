export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/patients/{patientApricotId}/treatment-summary — 治療摘要 API
// （read-chain MD §4.3）— cwc-rdchain-20260823-b1
//
//   Header: X-Api-Key（scope: patients — §A.2 守門）
//
//   200: { v:1, patientCode, patientName, syncedAt,
//          visits:[{ date, clinicCode, providerName, visitReasons, remarks }] }
//   404: { error, code:'PATIENT_NOT_FOUND' }（病人唔喺 PatientIndex）
//
// 規則：
//   - visits = 該病人 AppointmentIndex **過去行（date ≤ 今日 HK 日界）倒序 cap 50**
//   - **只計 bookingStatus ≥ 0**（0 confirmed / 102 rescheduled / 4 完成）—
//     負數（-6/-7 取消類）唔算「到診」：MD §4.3 註 — 唔好將取消單當治療史
//   - 未來行（date > 今日）唔計入（未发生唔係治療史）
//   - syncedAt = 回傳 visits 入面最新 syncedAt（冇 visits → null）
//
// 🔴 Audit 路徑用 :patientApricotId 佔位（audit 零 PII — 唔寫真實 apricot id）。
// 🔴 Response 只係白名單 v2：id/code/fullName + visitReasons + remarks。
// ============================================================

const MAX_VISITS = 50

export async function GET(req: NextRequest, { params }: { params: { patientApricotId: string } }) {
  const patientApricotId = params.patientApricotId ?? ''
  const auditPath = '/api/external/v1/patients/:patientApricotId/treatment-summary'
  return withExternalAudit(req, auditPath, async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    if (!patientApricotId) {
      throw new ExternalApiError(400, 'patientApricotId required', 'BAD_REQUEST')
    }

    const patient = await basePrisma.patientIndex.findUnique({
      where: { patientApricotId },
      select: { patientApricotId: true, patientCode: true, patientName: true },
    })
    if (!patient) {
      throw new ExternalApiError(404, 'patient not found', 'PATIENT_NOT_FOUND')
    }

    // 過去行倒序 cap 50；只計 bookingStatus ≥ 0（負數取消唔算到診 — MD §4.3）
    const today = toHKDateStr(new Date())
    const rows = await basePrisma.appointmentIndex.findMany({
      where: { patientApricotId, date: { lte: today }, bookingStatus: { gte: 0 } },
      orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
      take: MAX_VISITS,
      select: {
        date: true,
        clinicId: true,
        providerName: true,
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

    // syncedAt = 回傳 visits 最新 syncedAt（MD §4.3 sample 頂層欄）
    let maxSynced: Date | null = null
    for (const r of rows) {
      if (!maxSynced || r.syncedAt > maxSynced) maxSynced = r.syncedAt
    }

    return jsonNoStore({
      v: 1,
      patientCode: patient.patientCode,
      patientName: patient.patientName,
      syncedAt: maxSynced ? maxSynced.toISOString() : null,
      visits: rows.map(r => ({
        date: r.date,
        clinicCode: clinicCodeById.get(r.clinicId) ?? r.clinicId,
        providerName: r.providerName,
        visitReasons: r.visitReasons,
        remarks: r.remarks,
      })),
    })
  })
}
