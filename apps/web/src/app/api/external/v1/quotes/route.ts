export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/quotes（cwi-followup-p4-20260916 S3 — E 類 scan 用）
//
//   ?patientApricotId=   按病人（可選 — 唔傳 = 全庫 batch）
//   ?status=             pending|confirmed|corrected|discarded（可選；預設 pending+confirmed+corrected）
//   ?limit=              預設 200，max 500
//   ?clinicIds=          逗號分隔 Clinic.id（cuid）— cwi-final S5-13①（W-6）
//   ?clinicCodes=        逗號分隔 shortName（兼容；未識 code → 400 CLINIC_CODE_NOT_FOUND）
//                        兩者同傳 = union；有就 where.clinicId in（server-side filter，
//                        consumer 唔使再攞 500 條自 filter — S0-7 fallback 退役）
//   200: { v:1, quotes: [{ id, patientApricotId, clinicCode, sourceVisitDate, text,
//          termShorthand, nameCn, amountMin, amountMax, perUnit, fdiTeeth,
//          intent, certainty, source, status }] }
//
// 邊界：零原始電話（只 patientApricotId 業務 id）；零臨床全文（只結構化報價項）。
// Header: X-Api-Key（scope: patients）
// ============================================================

const STATUSES = ['pending', 'confirmed', 'corrected', 'discarded'] as const

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/quotes', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const sp = new URL(req.url).searchParams
    const patientApricotId = sp.get('patientApricotId')?.trim() || null
    const statusRaw = (sp.get('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const limitRaw = parseInt(sp.get('limit') ?? '200', 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200

    const statuses = statusRaw.length ? statusRaw.filter((s) => (STATUSES as readonly string[]).includes(s)) : ['pending', 'confirmed', 'corrected']
    if (statusRaw.length && !statuses.length) {
      throw new ExternalApiError(400, `status must be one of ${STATUSES.join('|')}`, 'BAD_REQUEST')
    }

    // ★ cwi-final S5-13①：clinic filter（cuid 主、shortName 兼容）
    const splitParam = (raw: string | null) =>
      (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 64)
    const clinicIdParam = splitParam(sp.get('clinicIds'))
    const clinicCodeParam = splitParam(sp.get('clinicCodes'))
    let clinicFilter: { in: string[] } | null = null
    if (clinicIdParam.length || clinicCodeParam.length) {
      const ids = new Set(clinicIdParam)
      if (clinicCodeParam.length) {
        const clinics = await basePrisma.clinic.findMany({
          where: { shortName: { in: clinicCodeParam } },
          select: { id: true, shortName: true },
        })
        const known = new Set(clinics.map((c) => c.shortName))
        const unknown = [...new Set(clinicCodeParam)].filter((c) => !known.has(c))
        if (unknown.length) {
          throw new ExternalApiError(400, `unknown clinicCode: ${unknown.join(', ')}`, 'CLINIC_CODE_NOT_FOUND')
        }
        for (const c of clinics) ids.add(c.id)
      }
      clinicFilter = { in: [...ids] }
    }

    const rows = await basePrisma.quotedItem.findMany({
      where: {
        ...(patientApricotId ? { patientApricotId } : {}),
        ...(clinicFilter ? { clinicId: clinicFilter } : {}),
        status: { in: statuses },
      },
      orderBy: [{ sourceVisitDate: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    })

    const clinics = await basePrisma.clinic.findMany({ select: { id: true, shortName: true } })
    const codeById = new Map(clinics.map((c) => [c.id, c.shortName ?? c.id]))

    return jsonNoStore({
      v: 1,
      quotes: rows.map((r) => ({
        id: r.id,
        patientApricotId: r.patientApricotId,
        clinicCode: codeById.get(r.clinicId) ?? r.clinicId,
        sourceVisitDate: r.sourceVisitDate.toISOString().slice(0, 10),
        text: r.text,
        termShorthand: r.termShorthand,
        nameCn: r.nameCn,
        amountMin: r.amountMin,
        amountMax: r.amountMax,
        perUnit: r.perUnit,
        fdiTeeth: r.fdiTeeth,
        intent: r.intent,
        certainty: r.certainty,
        source: r.source,
        status: r.status,
      })),
    })
  })
}
