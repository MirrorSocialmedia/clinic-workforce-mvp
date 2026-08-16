/**
 * GET /api/payout-runs — List payout runs (OWNER / provider_payout)
 * POST /api/payout-runs — Generate & lock payout run (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { jsonNoStore } from '@/lib/api-response'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { runGates, computePayout, lockPayoutRun } from '@/lib/payout/engine'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const providerId = searchParams.get('providerId')
  const periodMonth = searchParams.get('periodMonth')
  const clinicId = searchParams.get('clinicId')

  const where: any = {}
  if (providerId) where.providerId = providerId
  if (periodMonth) where.periodMonth = periodMonth
  if (clinicId) where.clinicId = clinicId

  const runs = await prisma.payoutRun.findMany({
    where,
    orderBy: { periodMonth: 'desc' },
  })

  // Fetch providers separately for inclusion
  const providerIds = [...new Set(runs.map(r => r.providerId))]
  const providers = await prisma.provider.findMany({
    where: { id: { in: providerIds } },
    select: { id: true, name: true, shortName: true },
  })
  const providerMap = new Map(providers.map(p => [p.id, p]))

  // ★ Fetch clinics for inclusion
  const clinicIds = [...new Set(runs.map(r => r.clinicId).filter(Boolean))]
  const clinics = await prisma.clinic.findMany({
    where: { id: { in: clinicIds } },
    select: { id: true, name: true, shortName: true },
  })
  const clinicMap = new Map(clinics.map(c => [c.id, c]))

  return jsonNoStore({
    runs: runs.map(r => ({
      ...r,
      provider: providerMap.get(r.providerId) || null,
      clinic: clinicMap.get(r.clinicId) || null,
      grossAmount: Number(r.grossAmount),
      rawAmount: Number(r.rawAmount),
      labCost: Number(r.labCost),
      implantCost: Number(r.implantCost),
      invisalignCost: Number(r.invisalignCost),
      profitAmount: Number(r.profitAmount),
      percentUsed: Number(r.percentUsed),
      salaryAmount: Number(r.salaryAmount),
      spSubsidy: Number(r.spSubsidy),
      refAmount: Number(r.refAmount),
      adjustAmount: Number(r.adjustAmount),
      totalAmount: Number(r.totalAmount),
    })),
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({}))
  const { providerId, periodMonth, clinicId } = body

  if (!providerId || !periodMonth || !clinicId) {
    return NextResponse.json({ error: 'providerId, periodMonth, clinicId 都係必填' }, { status: 400 })
  }

  // Check if run already exists (unique ternary key)
  const existing = await prisma.payoutRun.findUnique({
    where: { providerId_clinicId_periodMonth: { providerId, clinicId, periodMonth } },
  })
  if (existing) {
    return NextResponse.json(
      { error: `月結單已存在 (${existing.status})` },
      { status: 409 },
    )
  }

  // Run gates
  const { errors, warnings } = await runGates(providerId, periodMonth, clinicId)
  if (errors.length > 0) {
    return NextResponse.json(
      { error: errors.join('\n'), errors, warnings },
      { status: 400 },
    )
  }

  // Compute payout
  let payout: any
  try {
    payout = await computePayout(providerId, periodMonth, clinicId)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }

  // Lock
  const run = await lockPayoutRun(
    providerId,
    periodMonth,
    payout,
    auth.session!.userId,
    clinicId,
  )

  return NextResponse.json({
    run: {
      ...run,
      grossAmount: Number(run.grossAmount),
      rawAmount: Number(run.rawAmount),
      labCost: Number(run.labCost),
      implantCost: Number(run.implantCost),
      invisalignCost: Number(run.invisalignCost),
      profitAmount: Number(run.profitAmount),
      percentUsed: Number(run.percentUsed),
      salaryAmount: Number(run.salaryAmount),
      spSubsidy: Number(run.spSubsidy),
      refAmount: Number(run.refAmount),
      adjustAmount: Number(run.adjustAmount),
      totalAmount: Number(run.totalAmount),
    },
    warnings: [...warnings, ...payout.warnings],
  }, { status: 201 })
}
