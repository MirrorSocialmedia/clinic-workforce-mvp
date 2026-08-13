/**
 * MD-D: Payout Engine — 醫生拆帳引擎
 *
 * ★ 獨立模組，唔准 import payroll / timebank / prisma.employee
 * check-payout-boundary.sh 會攔
 */

import { Prisma, PaymentAllocation } from '@prisma/client'
import { prisma, basePrisma } from '@/lib/prisma'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'

// ─── Constants ───────────────────────────────────────────────────────────────

/** ★ 三個 flag 一個都唔准漏：每一條讀 PaymentAllocation 嘅 query 都要呢三個 */
export const ACTIVE_ALLOCATION = {
  isVoid: false,
  isSuperseded: false,
} as const

// SP item name patterns for auto-detection
export const SP_ITEM_NAMES = ['SCALING & POLISHING', 'S&P', '潔牙'] as const

// Mutable array for Prisma query
const SP_ITEM_NAMES_MUTABLE = [...SP_ITEM_NAMES] as string[]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

function sumByCosts(costs: any[], category: string): number {
  return sum(
    costs
      .filter((c: any) => c.category === category && c.finalCost != null)
      .map((c: any) => Number(c.finalCost))
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Get month range [1st 00:00 HK, last day 23:59:59.999 HK] — safe for all months */
function monthRange(periodMonth: string): [Date, Date] {
  const [y, m] = periodMonth.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return [
    hkDateStart(`${periodMonth}-01`),
    hkDateEnd(`${periodMonth}-${String(lastDay).padStart(2, '0')}`),
  ]
}

// ─── Commission Picker ──────────────────────────────────────────────────────

/**
 * Pick the most applicable ProviderCommission for a given period.
 *
 * Rule: effectiveFrom <= month-end, AND (effectiveTo IS NULL OR effectiveTo >= month-start)
 * Tiebreaker: { id: 'desc' } 必須有
 */
export async function pickCommission(
  providerId: string,
  periodMonth: string,
): Promise<any | null> {
  const [monthStart, monthEnd] = monthRange(periodMonth)

  const commission = await prisma.providerCommission.findFirst({
    where: {
      providerId,
      isActive: true,
      effectiveFrom: { lte: monthEnd },
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gte: monthStart } },
      ],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  })

  return commission
}

// ─── Gates ───────────────────────────────────────────────────────────────────

interface GateErrors {
  errors: string[]
  warnings: string[]
}

/**
 * Run 4 gates before payout computation.
 * Throws on fatal errors; returns warnings for non-fatal issues.
 */
export async function runGates(
  providerId: string,
  periodMonth: string,
): Promise<GateErrors> {
  const errors: string[] = []
  const warnings: string[] = []

  // Gate 1: Provider must have apricotId mapped
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
  })
  if (!provider?.apricotId) {
    errors.push(`PAYOUT_PROVIDER_NOT_MAPPED: 醫生 ${providerId} 未綁定 Apricot ID`)
  }

  // Gate 2: Must have an active commission for the period
  const commission = await pickCommission(providerId, periodMonth)
  if (!commission) {
    errors.push(`PAYOUT_NO_COMMISSION: 醫生 ${providerId} 喺 ${periodMonth} 無有效拆帳%設定`)
  }

  // Gate 3: No needsReview allocations allowed
  const needsReviewCount = await prisma.paymentAllocation.count({
    where: {
      ...ACTIVE_ALLOCATION,
      providerExtId: provider?.apricotId || '',
      periodMonth,
      needsReview: true,
    },
  })
  if (needsReviewCount > 0) {
    errors.push(`有 ${needsReviewCount} 筆付款方式未設定費率，無法生成月結單`)
  }

  // Gate 4: Cost cases without baseCost (warning, not fatal)
  const unpricedCount = await prisma.costCase.count({
    where: {
      providerId,
      periodMonth,
      status: { not: 'VOID' },
      baseCost: null,
    },
  })
  if (unpricedCount > 0) {
    warnings.push(`${unpricedCount} 筆成本記錄未有報價，可覆寫但月結單會標註`)
  }

  return { errors, warnings }
}

// ─── Core Computation ───────────────────────────────────────────────────────

interface PayoutBreakdownItem {
  method: string
  rawAmount: number
  feePercentUsed: number
  netAmount: number
  countAsIncome: boolean
}

interface PayoutResult {
  rawAmount: number
  grossAmount: number
  labCost: number
  implantCost: number
  invisalignCost: number
  profitAmount: number
  percentUsed: number
  salaryAmount: number
  spSubsidy: number
  refAmount: number
  adjustAmount: number
  totalAmount: number
  breakdown: PayoutBreakdownItem[]
  warnings: string[]
}

/**
 * Compute the full payout for a provider in a given month.
 *
 * Formula:
 *   ① Gross = Σ(PaymentAllocation.netAmount) excluding isVoid / isSuperseded / countAsIncome=false
 *   ② Cost = Lab + Implant + Invisalign (three separate categories)
 *   ③ Profit = Gross − Cost
 *   ④ Salary = Profit × 拆帳%
 *   ⑤ SP Subsidy = Σ((listPrice − actualPrice) × splitPercent% × headcount) ★ after ×%, full amount
 *   ⑥ Referral = Σ(unitPrice × qty × 2%) ★ full amount
 *   ⑦ Adjustments = ± manual / auto (void reversal)
 *   Total = ④ + ⑤ + ⑥ + ⑦
 */
export async function computePayout(
  providerId: string,
  periodMonth: string,
): Promise<PayoutResult> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
  })
  if (!provider?.apricotId) {
    throw new Error('PAYOUT_PROVIDER_NOT_MAPPED')
  }

  const warnings: string[] = []

  // ─── ① Gross from PaymentAllocation ─────────────────────────────────
  const allocs = await prisma.paymentAllocation.findMany({
    where: {
      ...ACTIVE_ALLOCATION,
      providerExtId: provider.apricotId,
      periodMonth,
      countAsIncome: true,
    },
  })

  const rawAmount = round2(sum(allocs.map((a: PaymentAllocation) => Number(a.amount))))
  const grossAmount = round2(sum(allocs.map((a: PaymentAllocation) => Number(a.netAmount))))

  // ─── ② Costs (three categories) ──────────────────────────────────────
  const costs = await prisma.costCase.findMany({
    where: {
      providerId,
      periodMonth,
      status: { not: 'VOID' },
      finalCost: { not: null },
    },
    include: { materials: true },
  })

  // Check for unpriced cases (warning)
  const unpricedCount = await prisma.costCase.count({
    where: {
      providerId,
      periodMonth,
      status: { not: 'VOID' },
      baseCost: null,
    },
  })
  if (unpricedCount > 0) {
    warnings.push(`${unpricedCount} 筆成本記錄未有報價`)
  }

  const labCost = round2(sumByCosts(costs, 'LAB'))
  const implantCost = round2(sumByCosts(costs, 'IMPLANT'))
  const invisalignCost = round2(sumByCosts(costs, 'INVISALIGN'))

  // ─── ③ Profit ────────────────────────────────────────────────────────
  const profitAmount = round2(grossAmount - labCost - implantCost - invisalignCost)

  // ─── ④ Salary = Profit × 拆帳% ───────────────────────────────────────
  const commission = await pickCommission(providerId, periodMonth)
  if (!commission) {
    throw new Error('PAYOUT_NO_COMMISSION')
  }
  const percentUsed = Number(commission.percent)
  const salaryAmount = round2(profitAmount * percentUsed / 100)

  // ─── ⑤ SP Subsidy (confirmed only, after ×%, full amount) ────────────
  const spSubsidyRecords = await prisma.spSubsidy.findMany({
    where: {
      providerId,
      periodMonth,
      confirmedBy: { not: null },
    },
  })
  const spSubsidy = round2(sum(spSubsidyRecords.map((x: any) => Number(x.amount))))

  // ─── ⑥ Referral (full amount) ────────────────────────────────────────
  const refRecords = await prisma.providerReferral.findMany({
    where: {
      fromProviderId: providerId,
      periodMonth,
    },
  })
  const refAmount = round2(sum(refRecords.map((x: any) => Number(x.amount))))

  // ─── ⑦ Adjustments (unassigned only) ─────────────────────────────────
  const adjustments = await prisma.payoutAdjustment.findMany({
    where: {
      providerId,
      periodMonth,
      runId: null,
    },
  })
  const adjustAmount = round2(sum(adjustments.map((x: any) => Number(x.amount))))

  // ─── Total ────────────────────────────────────────────────────────────
  const totalAmount = round2(salaryAmount + spSubsidy + refAmount + adjustAmount)

  // ─── Breakdown ────────────────────────────────────────────────────────
  const breakdown: PayoutBreakdownItem[] = allocs.map((a: PaymentAllocation) => ({
    method: a.methodNorm,
    rawAmount: Number(a.amount),
    feePercentUsed: Number(a.feePercentUsed),
    netAmount: Number(a.netAmount),
    countAsIncome: a.countAsIncome,
  }))

  return {
    rawAmount,
    grossAmount,
    labCost,
    implantCost,
    invisalignCost,
    profitAmount,
    percentUsed,
    salaryAmount,
    spSubsidy,
    refAmount,
    adjustAmount,
    totalAmount,
    breakdown,
    warnings,
  }
}

// ─── Lock / Unlock ──────────────────────────────────────────────────────────

/**
 * Lock a payout run: creates PayoutRun + locks related records.
 */
export async function lockPayoutRun(
  providerId: string,
  periodMonth: string,
  payout: PayoutResult,
  createdBy: string,
): Promise<any> {
  return await basePrisma.$transaction(async (tx: any) => {
    // a. Create PayoutRun with LOCKED status
    const run = await tx.payoutRun.create({
      data: {
        providerId,
        periodMonth,
        grossAmount: new Prisma.Decimal(String(payout.grossAmount)),
        rawAmount: new Prisma.Decimal(String(payout.rawAmount)),
        labCost: new Prisma.Decimal(String(payout.labCost)),
        implantCost: new Prisma.Decimal(String(payout.implantCost)),
        invisalignCost: new Prisma.Decimal(String(payout.invisalignCost)),
        profitAmount: new Prisma.Decimal(String(payout.profitAmount)),
        percentUsed: new Prisma.Decimal(String(payout.percentUsed)),
        salaryAmount: new Prisma.Decimal(String(payout.salaryAmount)),
        spSubsidy: new Prisma.Decimal(String(payout.spSubsidy)),
        refAmount: new Prisma.Decimal(String(payout.refAmount)),
        adjustAmount: new Prisma.Decimal(String(payout.adjustAmount)),
        totalAmount: new Prisma.Decimal(String(payout.totalAmount)),
        breakdownJson: payout.breakdown,
        status: 'LOCKED',
        lockedAt: new Date(),
        createdBy,
      },
    })

    // b. Lock CostCase
    await tx.costCase.updateMany({
      where: { providerId, periodMonth, status: { not: 'VOID' }, lockedByRunId: null },
      data: { lockedByRunId: run.id },
    })

    // c. Lock ProviderReferral
    await tx.providerReferral.updateMany({
      where: { fromProviderId: providerId, periodMonth, lockedByRunId: null },
      data: { lockedByRunId: run.id },
    })

    // d. Lock SpSubsidy
    await tx.spSubsidy.updateMany({
      where: { providerId, periodMonth, lockedByRunId: null },
      data: { lockedByRunId: run.id },
    })

    // e. Assign unassigned PayoutAdjustment
    await tx.payoutAdjustment.updateMany({
      where: { providerId, periodMonth, runId: null },
      data: { runId: run.id },
    })

    // f. Write audit log
    await tx.auditLog.create({
      data: {
        actorId: createdBy,
        action: 'PAYOUT_RUN_LOCK',
        entity: 'PayoutRun',
        entityId: run.id,
        notes: `鎖定月結單：${periodMonth}`,
        afterJson: JSON.stringify({
          providerId,
          periodMonth,
          totalAmount: payout.totalAmount,
        }),
      },
    })

    return run
  })
}

/**
 * Unlock a payout run: removes lock from related records.
 */
export async function unlockPayoutRun(
  runId: string,
  createdBy: string,
  reason: string,
): Promise<void> {
  return await basePrisma.$transaction(async (tx: any) => {
    const run = await tx.payoutRun.findUnique({ where: { id: runId } })
    if (!run) throw new Error('PAYOUT_RUN_NOT_FOUND')
    if (run.status !== 'LOCKED') throw new Error('PAYOUT_RUN_NOT_LOCKED')

    // Unlock related records
    await tx.costCase.updateMany({
      where: { lockedByRunId: runId },
      data: { lockedByRunId: null },
    })

    await tx.providerReferral.updateMany({
      where: { lockedByRunId: runId },
      data: { lockedByRunId: null },
    })

    await tx.spSubsidy.updateMany({
      where: { lockedByRunId: runId },
      data: { lockedByRunId: null },
    })

    await tx.payoutAdjustment.updateMany({
      where: { runId },
      data: { runId: null },
    })

    // Update run status
    await tx.payoutRun.update({
      where: { id: runId },
      data: { status: 'DRAFT', lockedAt: null },
    })

    // Write audit log
    await tx.auditLog.create({
      data: {
        actorId: createdBy,
        action: 'PAYOUT_RUN_UNLOCK',
        entity: 'PayoutRun',
        entityId: runId,
        notes: `解鎖月結單：${run.periodMonth} — 原因：${reason}`,
      },
    })
  })
}

// ─── SP Subsidy Auto-Detection ──────────────────────────────────────────────

/**
 * Auto-detect 2-person SP subsidy opportunities from Apricot bill items.
 * Returns candidates (source='AUTO', confirmedBy=null) for manual confirmation.
 */
export async function scanSpSubsidies(periodMonth: string): Promise<any[]> {
  const [monthStart, monthEnd] = monthRange(periodMonth)

  const spItems = await prisma.apricotBillItem.findMany({
    where: {
      feeItemDes: { in: SP_ITEM_NAMES_MUTABLE },
      OR: [{ discAmt: { gt: 0 } }, { discPer: { gt: 0 } }],
      bill: {
        billTime: { gte: monthStart, lte: monthEnd },
        isVoid: false,
      },
    },
    include: { bill: true },
  })

  const candidates: any[] = []
  for (const item of spItems) {
    const bill: any = (item as any).bill
    const provider = bill.providerExtId
      ? await prisma.provider.findUnique({
          where: { apricotId: bill.providerExtId! },
        })
      : null

    if (!provider) continue

    // F5: Fetch per-provider split% from commission instead of hardcoded 50
    const commission = await pickCommission(provider.id, periodMonth)
    const pct = commission ? Number(commission.percent) : null
    if (pct == null) {
      console.warn('[sp] 醫生未設拆帳%，跳過', provider.id)
      continue
    }

    const unitPrice = Number(item.unitPrice)
    const qty = item.qty || 1
    const ttlDisc = Number(item.ttlDisc)
    const listPrice = unitPrice
    const actualPrice = round2(unitPrice - ttlDisc / qty)
    const headcount = qty
    const amount = round2(
      (listPrice - actualPrice) * (pct / 100) * headcount,
    )

    // Upsert: get or create
    const existing = await prisma.spSubsidy.findUnique({
      where: { billItemEleId: item.eleId },
    }).catch(() => null)

    if (existing) {
      await prisma.spSubsidy.update({
        where: { billItemEleId: item.eleId },
        data: {
          providerId: provider.id,
          billExtId: bill.extId,
          itemDes: item.feeItemDes,
          listPrice: new Prisma.Decimal(String(listPrice)),
          actualPrice: new Prisma.Decimal(String(actualPrice)),
          headcount,
          splitPercent: new Prisma.Decimal(String(pct)),
          amount: new Prisma.Decimal(String(amount)),
          source: 'AUTO',
          confirmedBy: null,
          periodMonth,
        },
      })
    } else {
      await prisma.spSubsidy.create({
        data: {
          providerId: provider.id,
          billExtId: bill.extId,
          billItemEleId: item.eleId,
          itemDes: item.feeItemDes,
          listPrice: new Prisma.Decimal(String(listPrice)),
          actualPrice: new Prisma.Decimal(String(actualPrice)),
          headcount,
          splitPercent: new Prisma.Decimal(String(pct)),
          amount: new Prisma.Decimal(String(amount)),
          source: 'AUTO',
          confirmedBy: null,
          periodMonth,
        },
      })
    }

    candidates.push({
      providerId: provider.id,
      itemDes: item.feeItemDes,
      listPrice,
      actualPrice,
      headcount,
      splitPercent: pct,
      amount,
      source: 'AUTO',
      confirmedBy: null,
      periodMonth,
    })
  }

  return candidates
}

// ─── Void/Refund Adjustment Creation ────────────────────────────────────────

/**
 * When an Apricot bill is voided/refunded AFTER a payout run is locked,
 * create a PayoutAdjustment for the NEXT month instead of modifying the old run.
 */
export async function createVoidAdjustment(
  providerId: string,
  originalMonth: string,
  targetMonth: string,
  amount: number,
  reason: 'VOID' | 'REFUND' | 'MANUAL',
  refCode: string | null,
  note: string,
  createdBy: string,
): Promise<any> {
  return await prisma.payoutAdjustment.create({
    data: {
      providerId,
      periodMonth: targetMonth,
      sourceMonth: originalMonth,
      reason,
      refCode: refCode || null,
      amount: new Prisma.Decimal(String(amount)),
      note,
      createdBy,
    },
  })
}
