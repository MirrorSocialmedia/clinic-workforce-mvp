import { NextRequest, NextResponse } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// POST /api/cost-cases/recompute — 折扣重算
// Roles: OWNER (provider_payout via perm override)
// Body: { labId, periodMonth }  — 重算指定 lab 指定月份嘅未鎖定 case
// ⚠️ 只重算未鎖定 (lockedByRunId == null) 嘅 case
// ⚠️ 只重算 LAB / INVISALIGN category（有 labId 嘅）
// ============================================================
export async function POST(req: NextRequest) {
  const permCheck = await requirePerm(req, 'provider_payout')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const body = await req.json()
  const { labId, periodMonth } = body

  if (!labId || !periodMonth) {
    return NextResponse.json({ error: 'labId and periodMonth are required' }, { status: 400 })
  }

  // Get the discount for this lab + month
  const discount = await prisma.labMonthlyDiscount.findFirst({
    where: { labId, periodMonth },
    orderBy: { createdAt: 'desc' },
    take: 1,
  })

  if (!discount) {
    return jsonNoStore({ error: `搵唔到 ${labId} 喺 ${periodMonth} 嘅折扣設定` }, { status: 404 })
  }

  const discountPct = Number(discount.discountPct)
  // ★ cwm-costguard-20261006：舊資料可能有超出範圍嘅折扣 → 唔重算
  if (!(discountPct >= 0 && discountPct <= 100)) {
    return jsonNoStore({ error: `折扣 ${discountPct}% 唔合理（要 0–100%），請先改返折扣設定` }, { status: 400 })
  }

  // Find all unpriced/unlocked cases for this lab + month
  const cases = await prisma.costCase.findMany({
    where: {
      labId,
      periodMonth,
      category: { in: ['LAB', 'INVISALIGN'] },
      lockedByRunId: null,
      status: { not: 'VOID' },
      baseCost: { not: null },
    },
  })

  let recomputedCount = 0
  let totalDiff = 0

  // ★ cwm-costguard-20261006：一齊成功一齊失敗（之前逐筆 update，中途出錯會改咗一半）；
  //   寫入時再驗 lockedByRunId: null —— 撈完之後先被鎖嘅單唔會被改
  const updates: Array<{ id: string; finalCost: number }> = []
  for (const c of cases) {
    const baseCost = Number(c.baseCost!)
    const newFinalCost = Number((baseCost * (100 - discountPct) / 100).toFixed(2))
    const oldFinalCost = c.finalCost ? Number(c.finalCost) : 0
    if (newFinalCost !== oldFinalCost) {
      updates.push({ id: c.id, finalCost: newFinalCost })
      totalDiff += newFinalCost - oldFinalCost
    }
  }
  await prisma.$transaction(async tx => {
    for (const u of updates) {
      const r = await tx.costCase.updateMany({
        where: { id: u.id, lockedByRunId: null },
        data: { discountPct, finalCost: u.finalCost },
      })
      if (r.count !== 1) throw new Error('有成本記錄喺重算期間被鎖定，請重新試')
    }
  })
  recomputedCount = updates.length

  totalDiff = Number(totalDiff.toFixed(2))

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_RECOMPUTE',
      entity: 'CostCase',
      entityId: `lab:${labId}:${periodMonth}`,
      beforeJson: JSON.stringify({ labId, periodMonth, discountPct, casesFound: cases.length }),
      afterJson: JSON.stringify({ recomputedCount, totalDiff }),
      notes: `折扣重算: ${periodMonth} ${recomputedCount} 筆 總成本 ±$${totalDiff}`,
    },
  } as any)

  return jsonNoStore({
    recomputedCount,
    totalDiff,
    discountPct,
    message: `重算 ${recomputedCount} 筆未鎖定 case，總成本 ±$${totalDiff}`,
  })
}
