export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/quotes/{id}（cwi-final S5-13① — 單條報價）
//
//   200: { v:1, quote: { ...同 /quotes 列表 item shape } }
//   404: QUOTE_NOT_FOUND
//
// 用途：受限用戶（scoped）按 id 取單條報價 — 取代 S0-7 嘅
// 「pending+confirmed+corrected 攞 500 條逐條搵」fallback。
// 白名單同列表完全一致（零原始電話、零臨床全文）。
// Header: X-Api-Key（scope: patients）
// ============================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withExternalAudit(req, '/api/external/v1/quotes/[id]', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const { id } = await params
    const row = await basePrisma.quotedItem.findUnique({ where: { id } })
    if (!row) throw new ExternalApiError(404, 'quote not found', 'QUOTE_NOT_FOUND')

    const clinics = await basePrisma.clinic.findMany({ select: { id: true, shortName: true } })
    const codeById = new Map(clinics.map((c) => [c.id, c.shortName ?? c.id]))

    return jsonNoStore({
      v: 1,
      quote: {
        id: row.id,
        patientApricotId: row.patientApricotId,
        clinicCode: codeById.get(row.clinicId) ?? row.clinicId,
        sourceVisitDate: row.sourceVisitDate.toISOString().slice(0, 10),
        text: row.text,
        termShorthand: row.termShorthand,
        nameCn: row.nameCn,
        amountMin: row.amountMin,
        amountMax: row.amountMax,
        perUnit: row.perUnit,
        fdiTeeth: row.fdiTeeth,
        intent: row.intent,
        certainty: row.certainty,
        source: row.source,
        status: row.status,
      },
    })
  })
}
