export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { todayHK } from '@/lib/hk-date'
import { firstLineOf } from '@/lib/clinical-index/extract-note-text'
import type { NoteText } from '@/lib/clinical-index/types'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/patients/{patientApricotId}/visits?limit — 側欄列表
// （MD §2.6 #4 + §2.4 邊界）— cwi-followup-p1-20260915
//
//   Query: limit（可選，default 50，max 100）
//   Header: X-Api-Key（scope: patients）
//
//   200: { v:1, patientCode, visits:[{ visitId, visitDate, clinicCode,
//          bookingStatus, visitReasonCodes, providerCode, hasNote, noteKind,
//          firstLine }] }
//
// 🔴 資料邊界（MD §2.4）：列表只回結構化 + **firstLine（≤60 字）** —
//    臨床全文只可以經 #5（/visits/{visitId}/note），每次 100% audit。
//    範圍：past visits（≤ today）；未來預約走 #3 appointments lane。
// 🔴 只回 phoneHashes 級識別（此 API 本身連 hash 都唔需要 — 病人已鎖定）。
// ============================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ patientApricotId: string }> },
) {
  return withExternalAudit(req, '/api/external/v1/patients/[patientApricotId]/visits', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const { patientApricotId } = await params
    const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get('limit') ?? 50) || 50, 1), 100)

    const rows = await basePrisma.clinicalRecordIndex.findMany({
      where: {
        patientApricotId,
        visitDate: { lte: new Date(`${todayHK()}T00:00:00Z`) },
      },
      orderBy: { visitDate: 'desc' },
      take: limit,
    })
    if (!rows.length) throw new ExternalApiError(404, 'no indexed visits', 'NOT_FOUND')

    // clinicCode 對映（shortName ?? id — 同 #3 同一口徑）
    const clinicIds = [...new Set(rows.map(r => r.clinicId))]
    const clinics = await basePrisma.clinic.findMany({ where: { id: { in: clinicIds } }, select: { id: true, shortName: true } })
    const clinicCodeById = new Map(clinics.map(c => [c.id, c.shortName ?? c.id]))

    return jsonNoStore({
      v: 1,
      patientCode: rows[0].patientCode,
      visits: rows.map(r => ({
        visitId: r.id,
        visitDate: r.visitDate.toISOString().slice(0, 10),
        clinicCode: clinicCodeById.get(r.clinicId) ?? r.clinicId,
        bookingStatus: r.bookingStatus,
        visitReasonCodes: r.visitReasonCodes,
        providerCode: r.providerCode,
        hasNote: r.hasNote,
        noteKind: r.noteKind,
        firstLine: r.hasNote ? firstLineOf(r.noteJson as NoteText | null) : null, // noteJson 由 extractNoteText 寫入（parseVersion 管版本）
      })),
    })
  })
}
