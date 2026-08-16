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
  const { providerId, periodMonth } = body

  if (!providerId || !periodMonth) {
    return NextResponse.json({ error: 'providerId and periodMonth required' }, { status: 400 })
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

  const allClinics = await prisma.clinic.findMany({
    where: { id: { in: [...allClinicIds] } },
    select: { id: true, name: true, shortName: true, apricotClinicId: true },
  })

  // Build result with source labels
  const clinics = allClinics
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
  })
}
