export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// POST /api/external/v1/quotes/{id}/decision（cwi-followup-p4-20260916 S3）
// — 報價確認隊列：✓ 收貨 / ✎ 改 / ✗ 丟（MD §5.2 第三層）
//
//   body: {
//     action: 'confirm' | 'correct' | 'discard',
//     fields?: { amountMin?, amountMax?, termShorthand?, nameCn?, text? },   // correct 用
//     teachTerm?: { shorthand, nameCn, nameEn?, usedFor? },                  // 收貨順手教字典
//     correctionNote?: string,
//     decidedBy?: string    // opaque staff id（零 PII）
//   }
//   200: { v:1, id, status, termMapUpserted?: boolean }
//   404: QUOTE_NOT_FOUND｜400: BAD_REQUEST
//
// teachTerm → ClinicalTermMap upsert（收貨順手教返字典 — MD §5.2 第三層）。
// Header: X-Api-Key（scope: patients）
// ============================================================

const ACTIONS = ['confirm', 'correct', 'discard'] as const
const USED_FOR_VALUES = ['after_treatment', 'quote_extraction', 'recall'] as const

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withExternalAudit(req, '/api/external/v1/quotes/[id]/decision', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const { id } = await params
    let body: any
    try {
      body = await req.json()
    } catch {
      throw new ExternalApiError(400, 'invalid JSON', 'BAD_REQUEST')
    }
    const action = typeof body?.action === 'string' ? body.action : ''
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      throw new ExternalApiError(400, `action must be one of ${ACTIONS.join('|')}`, 'BAD_REQUEST')
    }

    const row = await basePrisma.quotedItem.findUnique({ where: { id } })
    if (!row) throw new ExternalApiError(404, 'quote not found', 'QUOTE_NOT_FOUND')

    const decidedBy = typeof body?.decidedBy === 'string' && body.decidedBy.trim() ? body.decidedBy.trim().slice(0, 60) : 'anonymous'
    const now = new Date()

    // 教字典（收貨順手教返字典 — MD §5.2）
    let termMapUpserted = false
    if (body?.teachTerm && typeof body.teachTerm === 'object') {
      const t = body.teachTerm
      const shorthand = typeof t.shorthand === 'string' ? t.shorthand.trim() : ''
      const nameCn = typeof t.nameCn === 'string' ? t.nameCn.trim() : ''
      if (!shorthand || !nameCn) {
        throw new ExternalApiError(400, 'teachTerm requires shorthand + nameCn', 'BAD_REQUEST')
      }
      await basePrisma.clinicalTermMap.upsert({
        where: { shorthand },
        create: {
          shorthand,
          nameCn,
          nameEn: typeof t.nameEn === 'string' && t.nameEn.trim() ? t.nameEn.trim().slice(0, 80) : null,
          usedFor: Array.isArray(t.usedFor)
            ? t.usedFor.filter((v: unknown): v is string => typeof v === 'string' && (USED_FOR_VALUES as readonly string[]).includes(v))
            : ['quote_extraction'],
        },
        update: {
          nameCn,
          nameEn: typeof t.nameEn === 'string' && t.nameEn.trim() ? t.nameEn.trim().slice(0, 80) : undefined,
          active: true,
        },
      })
      termMapUpserted = true
    }

    // 決定
    const statusMap = { confirm: 'confirmed', correct: 'corrected', discard: 'discarded' } as const
    const update: Record<string, unknown> = {
      status: statusMap[action as keyof typeof statusMap],
      decidedBy,
      decidedAt: now,
    }
    if (action === 'correct') {
      const f = body?.fields ?? {}
      if (typeof f.amountMin === 'number' && Number.isFinite(f.amountMin) && f.amountMin >= 0) update.amountMin = Math.round(f.amountMin)
      if (typeof f.amountMax === 'number' && Number.isFinite(f.amountMax) && f.amountMax >= 0) update.amountMax = Math.round(f.amountMax)
      if (typeof f.text === 'string' && f.text.trim()) update.text = f.text.trim().slice(0, 80)
      if (typeof f.correctionNote === 'string' && f.correctionNote.trim()) update.correctionNote = f.correctionNote.trim().slice(0, 200)
      if (f.termShorthand !== undefined) {
        if (f.termShorthand === null) {
          update.termShorthand = null
          update.nameCn = null
        } else if (typeof f.termShorthand === 'string') {
          // 必須係字典既有詞（case-insensitive 正規化）
          const cands = await basePrisma.clinicalTermMap.findMany({ where: { active: true }, select: { shorthand: true, nameCn: true } })
          const hit = cands.find((c) => c.shorthand.toLowerCase() === f.termShorthand.trim().toLowerCase())
          if (!hit) throw new ExternalApiError(400, `termShorthand not in dictionary: ${f.termShorthand}`, 'BAD_REQUEST')
          update.termShorthand = hit.shorthand
          update.nameCn = typeof f.nameCn === 'string' && f.nameCn.trim() ? f.nameCn.trim() : hit.nameCn
        }
      } else if (typeof f.nameCn === 'string' && f.nameCn.trim()) {
        update.nameCn = f.nameCn.trim()
      }
      if (update.amountMin != null && update.amountMax == null) update.amountMax = update.amountMin
    }
    if (action === 'confirm' && typeof body?.correctionNote === 'string' && body.correctionNote.trim()) {
      update.correctionNote = body.correctionNote.trim().slice(0, 200)
    }

    await basePrisma.quotedItem.update({ where: { id }, data: update })
    return jsonNoStore({ v: 1, id, status: update.status, termMapUpserted })
  })
}
