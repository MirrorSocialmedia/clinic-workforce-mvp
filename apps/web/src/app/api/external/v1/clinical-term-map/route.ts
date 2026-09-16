export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// /api/external/v1/clinical-term-map（GET + PUT）
// — 速記術語表（MD §5.2/§5.3）— cwi-followup-p4-20260916 S1
//
//   GET 200: { v:1, terms: [{ shorthand, nameCn, nameEn, usedFor, active, updatedAt }] }
//            （active=false 照回 — W UI 顯示「已停用」；quote-parser 只用 active）
//   PUT body: { terms: [{ shorthand, nameCn, nameEn?, usedFor? }] }  ← 全列表 upsert
//            （W 術語表頁編輯後整單提交；停用 = 唔喺列表入面 → active=false 軟刪）
//   400: BAD_REQUEST（shorthand 空 / 超 50 條 / 欄位類型錯）
//   Header: X-Api-Key（scope: patients）
//
// 邊界：零病人資料（純術語表）→ 唔需要 EXTERNAL_NOTE_VIEWED 類內容 audit；
//   withExternalAudit 照寫 ExternalApiAudit（keyName/path/status/latency）。
// 解析規則（FDI/金額/意向詞）唔可編輯（MD §5.3）— 呢條 API 只詞表。
// ============================================================

const USED_FOR_VALUES = ['after_treatment', 'quote_extraction', 'recall'] as const
const MAX_TERMS = 50
const SHORTHAND_RE = /^[\p{L}\p{N}\s\-\.\(\)/]{1,40}$/u

function validateTerms(body: unknown): { shorthand: string; nameCn: string; nameEn: string | null; usedFor: string[] }[] {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as any).terms)) {
    throw new ExternalApiError(400, 'body must be { terms: [...] }', 'BAD_REQUEST')
  }
  const terms = (body as any).terms as any[]
  if (terms.length > MAX_TERMS) {
    throw new ExternalApiError(400, `too many terms (max ${MAX_TERMS})`, 'BAD_REQUEST')
  }
  return terms.map((t) => {
    if (typeof t !== 'object' || t === null) throw new ExternalApiError(400, 'term must be object', 'BAD_REQUEST')
    const shorthand = typeof t.shorthand === 'string' ? t.shorthand.trim() : ''
    const nameCn = typeof t.nameCn === 'string' ? t.nameCn.trim() : ''
    if (!shorthand || !SHORTHAND_RE.test(shorthand)) throw new ExternalApiError(400, 'invalid shorthand', 'BAD_REQUEST')
    if (!nameCn || nameCn.length > 40) throw new ExternalApiError(400, 'invalid nameCn', 'BAD_REQUEST')
    const nameEn = typeof t.nameEn === 'string' && t.nameEn.trim() ? t.nameEn.trim().slice(0, 80) : null
    const usedFor = Array.isArray(t.usedFor)
      ? t.usedFor.filter((v: unknown): v is (typeof USED_FOR_VALUES)[number] =>
          typeof v === 'string' && (USED_FOR_VALUES as readonly string[]).includes(v))
      : []
    return { shorthand, nameCn, nameEn, usedFor }
  })
}

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/clinical-term-map', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const rows = await basePrisma.clinicalTermMap.findMany({
      orderBy: { shorthand: 'asc' },
      select: { shorthand: true, nameCn: true, nameEn: true, usedFor: true, active: true, updatedAt: true },
    })
    return jsonNoStore({ v: 1, terms: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) })
  })
}

export async function PUT(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/clinical-term-map', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new ExternalApiError(400, 'invalid JSON', 'BAD_REQUEST')
    }
    const terms = validateTerms(body)
    const seen = new Set<string>()

    // 全列表 upsert：列表入面 = active；唔喺列表 = 軟刪（active=false）
    for (const t of terms) {
      if (seen.has(t.shorthand.toLowerCase())) throw new ExternalApiError(400, 'duplicate shorthand', 'BAD_REQUEST')
      seen.add(t.shorthand.toLowerCase())
      await basePrisma.clinicalTermMap.upsert({
        where: { shorthand: t.shorthand },
        create: { ...t },
        update: { nameCn: t.nameCn, nameEn: t.nameEn, usedFor: t.usedFor, active: true },
      })
    }
    const all = await basePrisma.clinicalTermMap.findMany({ where: { active: true }, select: { shorthand: true } })
    const kept = new Set(terms.map((t) => t.shorthand))
    const removed = all.filter((r) => !kept.has(r.shorthand))
    if (removed.length) {
      await basePrisma.clinicalTermMap.updateMany({
        where: { shorthand: { in: removed.map((r) => r.shorthand) } },
        data: { active: false },
      })
    }

    const rows = await basePrisma.clinicalTermMap.findMany({ orderBy: { shorthand: 'asc' },
      select: { shorthand: true, nameCn: true, nameEn: true, usedFor: true, active: true, updatedAt: true } })
    return jsonNoStore({ v: 1, upserted: terms.length, deactivated: removed.length,
      terms: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) })
  })
}
