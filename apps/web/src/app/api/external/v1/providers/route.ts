export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit } from '@/lib/external-api'
import { STALE_AFTER_MS } from '@/lib/apricot/sync-availability-cache'
import { basePrisma } from '@/lib/prisma'
import { resolveClinicByCode } from '@/lib/external-clinic'
import { normalizeApricotAccount } from '@/lib/apricot/account'
import { todayHK } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/providers[?clinicCode=] — 逐店醫生名錄（cwm-roster-20261001）
//
// 用途：wa-inbox 醫生名錄（Provider／ProviderClinic）自動同步。
//   青衣（TY）係另一個 Apricot 帳號 —— 同一個醫生喺唔同帳號有唔同 practitioner id；
//   inbox 落單／搵空檔一定要用【該店帳號】嘅 id。呢個 endpoint 逐店回該店實際用緊嘅 id。
//
// 來源：AvailabilityCache（該店【今日起】有排診嘅 practitioner — 由 15 分鐘 sync 寫入，
//   本身就係按該店帳號拉）→ ApricotPractitioner 對返本系統醫生（providerId／名）。
//   kind=CLINIC（診所收款身分）唔係醫生 → 剔走；未綁／UNKNOWN → 照回（providerId: null，名用 Apricot 快照）。
//
//   Header: X-Api-Key（scope: availability）
//   Query:  clinicCode（選填；唔帶 = 全部已接 Apricot 嘅店）
//   200: { v:1, clinics:[{ clinicId, clinicCode, apricotAccount, syncedAt, stale,
//          providers:[{ apricotId, name, providerId }] }] }
//
// ⚠️ consumer 契約：stale=true 或者 providers 空 → 只准「加」唔准「刪」
//   （sync 斷咗／該店暫時冇排診 ≠ 醫生走咗）。
// 🔴 零病人資料 —— 只有醫生名 + practitioner id。
// ============================================================

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/providers', async (ctx) => {
    const key = await requireExternalKey(req, 'availability')
    ctx.setKey(key.name)

    const clinicCode = new URL(req.url).searchParams.get('clinicCode')
    const clinics = clinicCode
      ? [await resolveClinicByCode(clinicCode)].map(c => ({ id: c.id, shortName: c.shortName, apricotAccount: c.apricotAccount }))
      : await basePrisma.clinic.findMany({
          where: { apricotClinicId: { not: null } },
          select: { id: true, shortName: true, apricotAccount: true },
          orderBy: { name: 'asc' },
        })
    if (clinics.length === 0) return jsonNoStore({ v: 1, clinics: [] })

    const today = todayHK()
    const rows = await basePrisma.availabilityCache.findMany({
      where: { clinicId: { in: clinics.map(c => c.id) }, date: { gte: today } },
      select: { clinicId: true, providerApricotId: true, providerName: true, syncedAt: true },
    })

    const ids = [...new Set(rows.map(r => r.providerApricotId))]
    const accts = ids.length
      ? await basePrisma.apricotPractitioner.findMany({
          where: { apricotId: { in: ids } },
          select: { apricotId: true, kind: true, providerId: true, provider: { select: { name: true, isActive: true } } },
        })
      : []
    const acctById = new Map(accts.map(a => [a.apricotId, a]))

    const out = clinics.map(c => {
      const mine = rows.filter(r => r.clinicId === c.id)
      let maxSynced: Date | null = null
      const byId = new Map<string, { apricotId: string; name: string; providerId: string | null }>()
      for (const r of mine) {
        if (!maxSynced || r.syncedAt > maxSynced) maxSynced = r.syncedAt
        if (byId.has(r.providerApricotId)) continue
        const a = acctById.get(r.providerApricotId)
        if (a?.kind === 'CLINIC') continue                  // 診所收款身分，唔係醫生
        if (a?.provider && a.provider.isActive === false) continue // 本系統已停用嘅醫生
        byId.set(r.providerApricotId, {
          apricotId: r.providerApricotId,
          name: (a?.kind === 'PROVIDER' && a.provider?.name) || r.providerName,
          providerId: a?.kind === 'PROVIDER' ? a.providerId ?? null : null,
        })
      }
      return {
        clinicId: c.id,
        clinicCode: c.shortName ?? c.id,
        apricotAccount: normalizeApricotAccount(c.apricotAccount),
        syncedAt: maxSynced ? maxSynced.toISOString() : null,
        stale: !maxSynced || Date.now() - maxSynced.getTime() > STALE_AFTER_MS,
        providers: [...byId.values()].sort((x, y) => x.name.localeCompare(y.name) || x.apricotId.localeCompare(y.apricotId)),
      }
    })

    return jsonNoStore({ v: 1, clinics: out })
  })
}
