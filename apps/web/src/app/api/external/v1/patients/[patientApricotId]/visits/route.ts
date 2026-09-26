export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError, requireStaffId } from '@/lib/external-api'
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
//   Header: X-Api-Key（scope: patients）＋ X-Staff-Id（必填 — cwi-final S5-14）
//   400: STAFF_ID_REQUIRED（冇 X-Staff-Id）
//
//   200: { v:1, patientCode, visits:[{ visitId, visitDate, clinicCode,
//          bookingStatus, visitReasonCodes, providerCode, hasNote, noteKind,
//          firstLine, rxCodes: [{ code, name }] }] }
//
// 🔴 資料邊界（MD §2.4）：列表只回結構化 + **firstLine（≤60 字）** +
//    **rxCodes（code + 顯示名 — 零全文、零電話）** — 臨床全文只可以經
//    #5（/visits/{visitId}/note），每次 100% audit。
//    範圍：past visits（≤ today）；未來預約走 #3 appointments lane。
// 🔴 只回 phoneHashes 級識別（此 API 本身連 hash 都唔需要 — 病人已鎖定）。
// 🔴 rxCodes audit（cwi-followup-p4 S4 — 規則同 P1 EXTERNAL_NOTE_VIEWED 一致）：
//    任何一行 rxCodes 非空 → 回內容**之前**先寫 AuditLog action=EXTERNAL_RX_VIEWED
//    （staffId + visitIds + 計數，**零藥物內容**）；audit 寫入失敗 → 500 唔出內容。
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
    const staffId = requireStaffId(req) // ★ cwi-final S5-14：必填（唔再 anonymous）

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

    // S4：藥物 code → 顯示名（ClinicalRxCode 字典；零全文 — 只 code + name）
    const rxRows = await basePrisma.clinicalRxCode.findMany({ select: { code: true, nameCn: true, nameEn: true, isAntibiotic: true } })
    const rxName = new Map(rxRows.map(r => [r.code, { name: r.nameCn || r.nameEn || r.code, isAntibiotic: r.isAntibiotic }]))
    const visits = rows.map(r => ({
      visitId: r.id,
      visitDate: r.visitDate.toISOString().slice(0, 10),
      clinicCode: clinicCodeById.get(r.clinicId) ?? r.clinicId,
      bookingStatus: r.bookingStatus,
      visitReasonCodes: r.visitReasonCodes,
      providerCode: r.providerCode,
      hasNote: r.hasNote,
      noteKind: r.noteKind,
      firstLine: r.hasNote ? firstLineOf(r.noteJson as NoteText | null) : null, // noteJson 由 extractNoteText 寫入（parseVersion 管版本）
      rxCodes: r.rxCodes.map(c => ({ code: c, name: rxName.get(c)?.name ?? c, isAntibiotic: rxName.get(c)?.isAntibiotic ?? false })),
    }))

    // 🔴 rxCodes 非空 → 先 audit 後出內容（同 P1 EXTERNAL_NOTE_VIEWED 規則）
    const withRx = visits.filter(v => v.rxCodes.length > 0)
    if (withRx.length) {
      try {
        await basePrisma.auditLog.create({
          data: {
            actorId: null, // 系統身份（external API key lane）
            action: 'EXTERNAL_RX_VIEWED',
            entity: 'ClinicalRecordIndex',
            entityId: withRx[0].visitId,
            clinicId: rows[0].clinicId,
            // 零藥物內容：只 staffId + visitIds + 計數
            notes: JSON.stringify({ staffId, patientApricotId, visits: withRx.map(v => v.visitId), rxCount: withRx.reduce((s, v) => s + v.rxCodes.length, 0) }),
          },
        })
      } catch (err) {
        console.error('[visits-rx] EXTERNAL_RX_VIEWED audit 寫入失敗（唔出內容）:', err)
        throw new ExternalApiError(500, 'audit write failed', 'INTERNAL')
      }
    }

    return jsonNoStore({ v: 1, patientCode: rows[0].patientCode, visits })
  })
}
