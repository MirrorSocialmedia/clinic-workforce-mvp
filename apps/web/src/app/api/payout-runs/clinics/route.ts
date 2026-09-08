/**
 * POST /api/payout-runs/clinics — Get available clinics for a provider+month
 * Returns clinics where the provider has income sources + bound clinics
 * Also returns uncovered clinics (has income but no payout run yet)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { ACTIVE_ALLOCATION } from '@/lib/payout/engine'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({}))
  const { providerId, periodMonth, clinicId } = body

  if (!periodMonth) {
    return NextResponse.json({ error: 'periodMonth 必填' }, { status: 400 })
  }

  // ★ cwm-payoutcost-20260908 A1：「全部診所」名單 — 本 route 回應統一帶埋。
  //   MD fallback：本 route 有 provider_payout override（config.ts），而 GET /api/clinics
  //   對 my-clinics scope 用戶會 filter session.clinics（同本頁 scope 語義唔一致）
  //   → 前端唔好依賴 GET /api/clinics，改由本 route 供 allClinics。
  const allClinics = await prisma.clinic.findMany({
    select: { id: true, name: true, shortName: true },
    orderBy: { createdAt: 'asc' },
  })

  // ★ cwm-payoutcost-20260908 A1：list mode — 淨 periodMonth（未揀 provider/clinic）。
  //   前端 mount 時 call 呢個 mode 填診所下拉（反方向流程第一步）。
  if (!providerId && !clinicId) {
    return NextResponse.json({ providers: [], uncoveredProviders: [], allClinics })
  }

  // ★ cwm-payoutcost-20260908 A1：反方向 —— 診所 + 月 → 有收入嘅醫生
  //   ⚠️ 只喺「淨傳 clinicId」時行；兩個都傳（= 有 providerId）= 舊行為（醫生 → 診所），唔改語義
  if (clinicId && !providerId) {
    return await providersForClinic(clinicId, periodMonth, allClinics)
  }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: { clinics: true },
  })
  if (!provider) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  }

  // 1. Clinics from PaymentAllocation (provider has income)
  let apricotClinicIds: string[] = []
  let refClinicIds: string[] = []

  if (provider.apricotId) {
    const allocRows = await prisma.paymentAllocation.findMany({
      where: {
        providerExtId: provider.apricotId,
        periodMonth,
        ...ACTIVE_ALLOCATION,
      },
      select: { clinicExtId: true },
      distinct: ['clinicExtId'],
    })
    apricotClinicIds = allocRows.map(r => r.clinicExtId).filter(Boolean) as string[]
  }

  const refRows = await prisma.providerReferral.findMany({
    where: {
      fromProviderId: providerId,
      periodMonth,
    },
    select: { clinicId: true },
    distinct: ['clinicId'],
  })
  refClinicIds = refRows.map(r => r.clinicId).filter(Boolean) as string[]

  // 2. Resolve clinicExtId → Clinic records
  const incomeClinics = apricotClinicIds.length > 0
    ? await prisma.clinic.findMany({
        where: {
          apricotClinicId: { in: apricotClinicIds },
        },
        select: { id: true, name: true, shortName: true },
      })
    : []
  const incomeClinicIds = new Set(incomeClinics.map(c => c.id))

  // 3. Resolve ref clinicIds → Clinic records (may include clinics not in Apricot)
  const refClinicRecords = refClinicIds.length > 0
    ? await prisma.clinic.findMany({
        where: { id: { in: refClinicIds } },
        select: { id: true, name: true, shortName: true },
      })
    : []

  // 4. Bound clinics (ProviderClinic)
  const boundClinics = provider.clinics.map(pc => ({
    id: pc.clinicId,
    name: '', // will be filled
    shortName: null,
  }))

  // 5. Union all clinics
  const allClinicIds = new Set([
    ...incomeClinicIds,
    ...refClinicRecords.map(c => c.id),
    ...boundClinics.map(c => c.id),
  ])

  // ★ A1：改名 unionClinics — 避免同上方「全部診所名單」allClinics 同名衝突
  const unionClinics = await prisma.clinic.findMany({
    where: { id: { in: [...allClinicIds] } },
    select: { id: true, name: true, shortName: true, apricotClinicId: true },
  })

  // Build result with source labels
  const clinics = unionClinics
    .filter(clinic => {
      // Only include clinics with apricotClinicId, unless they only have REF income
      const hasApricotId = !!clinic.apricotClinicId
      const hasRefOnly = refClinicIds.includes(clinic.id) && !incomeClinicIds.has(clinic.id)
      return hasApricotId || hasRefOnly
    })
    .map(clinic => {
      let source: 'PROVIDER_CLINIC' | 'ALLOCATION' | 'REFERRAL' = 'PROVIDER_CLINIC'
      if (incomeClinicIds.has(clinic.id)) source = 'ALLOCATION'
      else if (refClinicIds.includes(clinic.id)) source = 'REFERRAL'
      return {
        id: clinic.id,
        name: clinic.name,
        shortName: clinic.shortName,
        source,
      }
    })

  // 6. Uncovered clinics: clinics where provider has income but no payout run yet
  const existingRuns = await prisma.payoutRun.findMany({
    where: {
      providerId,
      periodMonth,
    },
  })
  const coveredClinicIds = new Set(existingRuns.map(r => r.clinicId))

  const uncoveredClinics = clinics.filter(c => {
    if (coveredClinicIds.has(c.id)) return false
    // Only flag as uncovered if they have actual income (ALLOCATION or REFERRAL)
    return c.source === 'ALLOCATION' || c.source === 'REFERRAL'
  })

  return NextResponse.json({
    clinics,
    uncoveredClinics,
    allClinics, // ★ A1：順便刷新前端「全部診所」名單
  })
}

/**
 * ★ cwm-payoutcost-20260908 A1：clinicId + periodMonth → 有收入 / 有綁定嘅醫生
 * 係 POST 主體嗰段「醫生 → 診所」嘅鏡像，三個來源完全對稱：
 *   PaymentAllocation（付款）/ ProviderReferral（轉介）/ ProviderClinic（綁定）
 *
 * ★★ isActive 唔准 filter —— 停用咗嘅醫生一樣可能有上個月收入要出月結。
 * ⚠️ P2（記低唔做）：PaymentAllocation 冇 clinicExtId index → 呢條 query 會 seq scan，
 *   行數上到幾萬要補 @@index([clinicExtId, periodMonth])。
 */
async function providersForClinic(
  clinicId: string,
  periodMonth: string,
  allClinics: { id: string; name: string; shortName: string | null }[],
) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, apricotClinicId: true },
  })
  if (!clinic) return NextResponse.json({ error: 'Clinic not found' }, { status: 404 })

  // 1. 有付款收入（經 apricotClinicId ↔ clinicExtId）
  let allocExtIds: string[] = []
  if (clinic.apricotClinicId) {
    const rows = await prisma.paymentAllocation.findMany({
      where: {
        clinicExtId: clinic.apricotClinicId,
        periodMonth,
        ...ACTIVE_ALLOCATION,
      },
      select: { providerExtId: true },
      distinct: ['providerExtId'],
    })
    allocExtIds = rows.map(r => r.providerExtId).filter(Boolean) as string[]
  }
  const allocProviders = allocExtIds.length > 0
    ? await prisma.provider.findMany({
        where: { apricotId: { in: allocExtIds } },
        select: { id: true, name: true, shortName: true },
      })
    : []
  const allocIds = new Set(allocProviders.map(p => p.id))

  // 2. 有轉介收入（ProviderReferral.clinicId = 實際做／收錢嗰間，2026-08-16 拍板）
  const refRows = await prisma.providerReferral.findMany({
    where: { clinicId, periodMonth },
    select: { fromProviderId: true },
    distinct: ['fromProviderId'],
  })
  const refIds = new Set(refRows.map(r => r.fromProviderId))

  // 3. 綁咗呢間店
  const boundRows = await prisma.providerClinic.findMany({
    where: { clinicId },
    select: { providerId: true },
  })
  const boundIds = new Set(boundRows.map(r => r.providerId))

  const allIds = [...new Set([...allocIds, ...refIds, ...boundIds])]
  const all = allIds.length > 0
    ? await prisma.provider.findMany({
        where: { id: { in: allIds } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, shortName: true },
      })
    : []

  const providers = all.map(p => ({
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    source: allocIds.has(p.id) ? 'ALLOCATION'
      : refIds.has(p.id) ? 'REFERRAL'
      : 'PROVIDER_CLINIC',
  }))

  // 4. 有收入（ALLOCATION/REFERRAL）但呢間店呢個月未生成 run
  const existingRuns = await prisma.payoutRun.findMany({
    where: { clinicId, periodMonth },
    select: { providerId: true },
  })
  const covered = new Set(existingRuns.map(r => r.providerId))
  const uncoveredProviders = providers.filter(
    p => !covered.has(p.id) && (p.source === 'ALLOCATION' || p.source === 'REFERRAL'),
  )

  return NextResponse.json({ providers, uncoveredProviders, allClinics })
}
