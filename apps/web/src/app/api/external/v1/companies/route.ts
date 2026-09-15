export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import { basePrisma } from '@/lib/prisma'

// ============================================================
// GET /api/external/v1/companies
// （cwi-followup-p0-20260915 — MD §1.1，scope org）
//
//   200 { v:1, companies: [{ id, name, clinics:[{ id, code, name }] }] }
//   401/403/429 §A.2
//
// 公司主資料唯一來源（wa-inbox 嘅 Company 表降格做快取 — 同步而唔係重建）。
// 公司來源 = 本系統 Company 表（master）；Clinic 經 companyId 關聯。
// clinics[].code = Clinic.shortName（CWM Clinic 無 code 欄 — 鐵律 5）。
// shortName 空嘅 clinic 剔走（wa-inbox 按 code 對店 — 冇 code 對唔到，留低只係噪音）。
//
// companyApricotId：CWM Company 表而家無 apricot id 欄 → 唔回（MD 標 optional）。
// 零病人資料、零電話 — 純機構代碼表。
// ============================================================

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/companies', async (ctx) => {
    const key = await requireExternalKey(req, 'org')
    ctx.setKey(key.name)

    const [companies, clinics] = await Promise.all([
      basePrisma.company.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      basePrisma.clinic.findMany({
        select: { id: true, name: true, shortName: true, companyId: true },
      }),
    ])

    const byCompany = new Map<string, { id: string; code: string; name: string }[]>()
    for (const c of clinics) {
      if (!c.shortName || !c.companyId) continue // 無 code / 無公司 → wa-inbox 對唔到，剔
      const arr = byCompany.get(c.companyId) ?? []
      arr.push({ id: c.id, code: c.shortName, name: c.name })
      byCompany.set(c.companyId, arr)
    }

    return jsonNoStore({
      v: 1,
      companies: companies.map((c) => ({
        id: c.id,
        name: c.name,
        clinics: (byCompany.get(c.id) ?? []).sort((a, b) => a.code.localeCompare(b.code)),
      })),
    })
  })
}
