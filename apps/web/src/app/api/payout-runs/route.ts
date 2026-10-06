/**
 * GET /api/payout-runs — List payout runs (OWNER / provider_payout)
 * POST /api/payout-runs — Generate & lock payout run (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { jsonNoStore } from '@/lib/api-response'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { runGates, computePayout, lockPayoutRun, CostChangedDuringLockError } from '@/lib/payout/engine'
import { costDetail, totalReminders } from '@/lib/payout/cost-detail'
import { spReview, spReviewNeeded } from '@/lib/payout/sp-review'
import { dailyReview } from '@/lib/payout/daily-review'
import { todayHK } from '@/lib/hk-date'

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

  // ★ cwm-costdetail-20261006：有「當月未計入」成本 → 要喺預覽剔「我已檢查」先可以鎖（老闆拍板）
  if (body.costReviewAck !== true) {
    const reminders = totalReminders(await costDetail(providerId, clinicId, periodMonth, todayHK()))
    if (reminders > 0) {
      return NextResponse.json(
        { error: `有 ${reminders} 項成本當月未計入，請先預覽檢查，剔「我已檢查」再鎖定`, code: 'COST_REVIEW_REQUIRED', reminders },
        { status: 409 },
      )
    }
  }

  // ★ cwm-sppreview-20261006：仲有未確認 2人SP，或者成間店未掃描 → 要喺預覽剔「我知道」先鎖得
  if (body.spReviewAck !== true) {
    const sp = await spReview(providerId, clinicId, periodMonth)
    if (spReviewNeeded(sp)) {
      const msg = sp.pending.length > 0
        ? `仲有 ${sp.pending.length} 筆 2人SP 未確認（$${sp.pendingTotal}），請先預覽，剔「我知道」再鎖定`
        : `${sp.clinicName} ${periodMonth} 仲未掃描 2人SP，請先預覽，剔「我知道」再鎖定`
      return NextResponse.json({ error: msg, code: 'SP_REVIEW_REQUIRED' }, { status: 409 })
    }
  }

  // ★ cwm-dailyreview-20261006：每日收款有未核對／核對後有變 → 要喺預覽剔「我知道」先鎖得
  if (body.dailyReviewAck !== true) {
    const d = await dailyReview(providerId, clinicId, periodMonth)
    if (d.needsAck) {
      return NextResponse.json({
        error: `每日收款仲有 ${d.counts.unchecked} 日未核對、${d.counts.changed} 日核對後有變，請先預覽，剔「我知道」再鎖定`,
        code: 'DAILY_REVIEW_REQUIRED',
      }, { status: 409 })
    }
  }

  // Compute payout
  let payout: any
  try {
    payout = await computePayout(providerId, periodMonth, clinicId)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }

  // Lock
  let run: Awaited<ReturnType<typeof lockPayoutRun>>
  try {
    run = await lockPayoutRun(
      providerId,
      periodMonth,
      payout,
      auth.session!.userId,
      clinicId,
    )
  } catch (e) {
    // ★ cwm-costguard-20261006：鎖定期間成本有改動 → transaction 已回滾
    if (e instanceof CostChangedDuringLockError) return NextResponse.json({ error: e.message }, { status: 409 })
    // ★ cwm-payaudit-20261006：兩個人同時生成同一張（unique providerId+clinicId+periodMonth）→ 409，唔好 500
    if ((e as any)?.code === 'P2002') return NextResponse.json({ error: '呢張月結單啱啱已經有人生成咗，請重新整理' }, { status: 409 })
    throw e
  }

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
