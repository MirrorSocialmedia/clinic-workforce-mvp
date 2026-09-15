export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import type { NoteText } from '@/lib/clinical-index/types'

// ============================================================
// GET /api/external/v1/patients/{patientApricotId}/visits/{visitId}/note
// — 臨床全文（MD §2.6 #5 + §2.4 邊界）— cwi-followup-p1-20260915
//
//   200: { v:1, visitId, patientApricotId, visitDate, noteKind, note }
//   404: VISIT_NOT_FOUND / NOTE_NOT_FOUND（hasNote=false）
//   Header: X-Api-Key（scope: patients）＋ X-Staff-Id（opaque，audit 用）
//
// 🔴🔴 100% AUDIT（MD §2.4 紅線）：每次成功回傳全文**之前**先寫
//    AuditLog action=EXTERNAL_NOTE_VIEWED（記 staffId + visitId，**零內容**）。
//    audit 寫入失敗 → 500（唔好喺無 audit 嘅情況下洩內容 — 最嚴口徑）。
// 🔴 全文只喺呢條 endpoint 出；列表（#4）只有 firstLine ≤60 字。
// ============================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ patientApricotId: string; visitId: string }> },
) {
  return withExternalAudit(req, '/api/external/v1/patients/[id]/visits/[visitId]/note', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const { patientApricotId, visitId } = await params
    const staffId = (req.headers.get('x-staff-id') ?? '').trim() || 'anonymous'

    const row = await basePrisma.clinicalRecordIndex.findUnique({ where: { id: visitId } })
    if (!row || row.patientApricotId !== patientApricotId) {
      throw new ExternalApiError(404, 'visit not found', 'VISIT_NOT_FOUND')
    }
    if (!row.hasNote || !row.noteJson) {
      throw new ExternalApiError(404, 'no note for this visit', 'NOTE_NOT_FOUND')
    }

    // 🔴 先 audit 後出內容（順序強制；audit 失敗 → 500 唔出內容）
    try {
      await basePrisma.auditLog.create({
        data: {
          actorId: null, // 系統身份（external API key lane）
          action: 'EXTERNAL_NOTE_VIEWED',
          entity: 'ClinicalRecordIndex',
          entityId: visitId,
          clinicId: row.clinicId,
          // 零內容：只有 staffId + visitId + 日期（MD §2.4）
          notes: JSON.stringify({ staffId, patientApricotId, visitId: row.id, visitDate: row.visitDate.toISOString().slice(0, 10) }),
        },
      })
    } catch (err) {
      console.error('[note-view] EXTERNAL_NOTE_VIEWED audit 寫入失敗（唔出內容）:', err)
      throw new ExternalApiError(500, 'audit write failed', 'INTERNAL')
    }

    return jsonNoStore({
      v: 1,
      visitId: row.id,
      patientApricotId: row.patientApricotId,
      visitDate: row.visitDate.toISOString().slice(0, 10),
      noteKind: row.noteKind,
      note: row.noteJson as NoteText,
    })
  })
}
