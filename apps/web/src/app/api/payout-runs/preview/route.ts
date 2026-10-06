/**
 * POST /api/payout-runs/preview — Preview payout without locking (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runGates, computePayout } from '@/lib/payout/engine'
import { costDetail, totalReminders } from '@/lib/payout/cost-detail'
import { todayHK } from '@/lib/hk-date'
import { spReview, spReviewNeeded } from '@/lib/payout/sp-review'
import { dailyReview } from '@/lib/payout/daily-review'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({}))
  const { providerId, periodMonth, clinicId } = body

  if (!providerId || !periodMonth || !clinicId) {
    return NextResponse.json({ error: 'providerId, periodMonth, clinicId 都係必填' }, { status: 400 })
  }

  // Run gates
  const { errors, warnings } = await runGates(providerId, periodMonth, clinicId)
  if (errors.length > 0) {
    return NextResponse.json(
      { error: errors.join('\n'), errors, warnings },
      { status: 400 },
    )
  }

  // Compute
  let payout: any
  try {
    payout = await computePayout(providerId, periodMonth, clinicId)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }

  // ★ cwm-costdetail-20261006：成本明細（已計入／當月未計入提醒）—— 鎖定前要剔「我已檢查」
  const detail = await costDetail(providerId, clinicId, periodMonth, todayHK())
  const extra: string[] = []
  if (Math.abs(detail.LAB.countedTotal - payout.labCost) > 0.005) {
    extra.push(`Lab 明細合計（${detail.LAB.countedTotal}）同月結（${payout.labCost}）唔一致，請通知管理員`)
  }

  // ★ cwm-sppreview-20261006：未確認 2人SP／未掃描 → 預覽提示，要剔「我知道」先鎖得
  const sp = await spReview(providerId, clinicId, periodMonth)

  // ★ cwm-dailyreview-20261006：每日收款＋護士核對狀態（逐日加埋要等於原始收入，唔夾就警告）
  const daily = await dailyReview(providerId, clinicId, periodMonth)
  if (Math.abs(daily.doctorTotal - payout.rawAmount) > 0.005) {
    extra.push(`每日收款合計（${daily.doctorTotal}）同原始收入（${payout.rawAmount}）唔一致，請通知管理員`)
  }

  return NextResponse.json({
    preview: payout,
    costDetail: detail,
    costReminders: totalReminders(detail),
    spReview: { ...sp, needsAck: spReviewNeeded(sp) },
    dailyReview: daily,
    warnings: [...warnings, ...payout.warnings, ...extra],
  })
}
