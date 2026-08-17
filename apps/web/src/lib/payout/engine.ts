/**
 * MD-D: Payout Engine — 醫生拆帳引擎
 *
 * ★ 獨立模組，唔准 import payroll / timebank / prisma.employee
 * check-payout-boundary.sh 會攔
 * ★ 2026-08-17: 粒度改為「醫生 × 診所 × 月」
 */

import { Prisma, PaymentAllocation } from '@prisma/client'
import { prisma, basePrisma } from '@/lib/prisma'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { SP_2P1K_PER_PERSON } from '@/lib/payout/constants'

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
 * ★ 2026-08-17: 加 clinic 優先 — clinic 專屬 > null（通用）
 *
 * Rule: effectiveFrom <= month-end, AND (effectiveTo IS NULL OR effectiveTo >= month-start)
 * Tiebreaker: { id: 'desc' } 必須有
 */
export async function pickCommission(
  providerId: string,
  periodMonth: string,
  clinicId?: string,
): Promise<any | null> {
  const [monthStart, monthEnd] = monthRange(periodMonth)

  const baseConditions = {
    providerId,
    isActive: true,
    effectiveFrom: { lte: monthEnd },
    OR: [
      { effectiveTo: null },
      { effectiveTo: { gte: monthStart } },
    ],
  } as any

  const where: any = clinicId
    ? {
        AND: [
          { ...baseConditions },
          { OR: [{ clinicId }, { clinicId: null }] },
        ],
      }
    : baseConditions

  const orderBy: any[] = []
  if (clinicId) {
    orderBy.push({ clinicId: { sort: 'desc' as const, nulls: 'last' } as const })
  }
  orderBy.push({ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { id: 'desc' })

  const commission = await prisma.providerCommission.findFirst({
    where,
    orderBy,
  })

  return commission
}

// ─── Gates ───────────────────────────────────────────────────────────────────

interface GateErrors {
  errors: string[]
  warnings: string[]
}

/**
 * Run gates before payout computation.
 * ★ 2026-08-17: 加 clinicId 參數，所有 gate 都收窄到該診所。
 * Throws on fatal errors; returns warnings for non-fatal issues.
 */
export async function runGates(
  providerId: string,
  periodMonth: string,
  clinicId: string,
): Promise<GateErrors> {
  const errors: string[] = []
  const warnings: string[] = []

  // Gate 0: 診所未對應 Apricot ID
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } })
  if (!clinic?.apricotClinicId) {
    errors.push(`診所「${clinic?.name ?? clinicId}」未對應 Apricot ID，無法生成月結`)
    return { errors, warnings }
  }

  // Gate 1: Provider must have apricotId mapped
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
  })
  if (!provider?.apricotId) {
    errors.push(`PAYOUT_PROVIDER_NOT_MAPPED: 醫生 ${providerId} 未綁定 Apricot ID`)
  } else {
    // Gate 1b①: 全歷史有冇對到 —— 答「ID 啱唔啱」
    const everHit = await prisma.paymentAllocation.count({
      where: { providerExtId: provider.apricotId },
    })
    if (everHit === 0) {
      errors.push(
        `醫生「${provider.name}」嘅 Apricot ID (${provider.apricotId}) ` +
        `喺所有已同步嘅付款入面一次都冇出現過。` +
        `請確認佢係 practitioner.id 而唔係 userId。`
      )
    } else {
      // Gate 1b②: 該月有冇 —— 答「今個月有冇收入」
      const monthHitWhere: any = {
        ...ACTIVE_ALLOCATION,
        providerExtId: provider.apricotId,
        periodMonth,
      }
      if (clinic?.apricotClinicId) {
        monthHitWhere.clinicExtId = clinic.apricotClinicId
      }
      const monthHit = await prisma.paymentAllocation.count({ where: monthHitWhere })
      if (monthHit === 0) {
        warnings.push(`醫生「${provider.name}」喺 ${periodMonth} 冇任何付款記錄，Gross 將會係 $0`)
      }
    }
  }

  // Gate 2: Must have an active commission for the period
  const commission = await pickCommission(providerId, periodMonth, clinicId)
  if (!commission) {
    errors.push(`PAYOUT_NO_COMMISSION: 醫生 ${providerId} 喺 ${periodMonth} 無有效拆帳%設定`)
  }

  // Gate 3: No needsReview allocations allowed
  const gate3Where: any = {
    ...ACTIVE_ALLOCATION,
    providerExtId: provider?.apricotId || '',
    periodMonth,
    needsReview: true,
  }
  if (clinic?.apricotClinicId) {
    gate3Where.clinicExtId = clinic.apricotClinicId
  }
  const needsReviewCount = await prisma.paymentAllocation.count({ where: gate3Where })
  if (needsReviewCount > 0) {
    errors.push(`有 ${needsReviewCount} 筆付款方式未設定費率，無法生成月結單`)
  }

  // Gate 4: Cost cases without baseCost (warning, not fatal)
  const gate4Where: any = {
    providerId,
    periodMonth,
    status: { not: 'VOID' },
    baseCost: null,
  }
  if (clinicId) gate4Where.clinicId = clinicId
  const unpricedCount = await prisma.costCase.count({ where: gate4Where })
  if (unpricedCount > 0) {
    warnings.push(`${unpricedCount} 筆成本記錄未有報價，可覆寫但月結單會標註`)
  }

  // R5: 材料單價經人手覆寫的計數
  const gate5Where: any = {
    costCase: {
      providerId,
      periodMonth,
      status: { not: 'VOID' },
    },
    isPriceOverridden: true,
  }
  if (clinicId) gate5Where.costCase.clinicId = clinicId
  const overriddenCount = await prisma.costCaseMaterial.count({ where: gate5Where })
  if (overriddenCount > 0) {
    warnings.push(`${overriddenCount} 筆材料單價經人手覆寫，請確認`)
  }


  // Orphan SP warning: confirmed SP subsidies without clinic data
  const orphanSp = await prisma.spSubsidy.count({
    where: {
      providerId,
      periodMonth,
      clinicId: null,
      status: 'CONFIRMED',
    },
  })
  if (orphanSp > 0) {
    warnings.push(`${orphanSp} 筆已確認嘅 SP 補貼冇診所資料，唔會計入任何月結單`)
  }

  // Orphan adjustment warning: adjustments without clinic data
  const orphanAdj = await prisma.payoutAdjustment.count({
    where: {
      providerId,
      periodMonth,
      clinicId: null,
      runId: null,
    },
  })
  if (orphanAdj > 0) {
    warnings.push(`${orphanAdj} 筆調整記錄冇診所資料，唔會計入任何月結單`)
  }

  // Orphan referral warning: referrals without clinic data
  const orphanRef = await prisma.providerReferral.count({
    where: {
      fromProviderId: providerId,
      periodMonth,
      clinicId: null,
    },
  })
  if (orphanRef > 0) {
    warnings.push(`${orphanRef} 筆轉介記錄冇診所資料，唔會計入任何月結單`)
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
 * ★ 2026-08-17: 加 clinicId — 所有資料源收窄到該診所。
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
  clinicId: string,
): Promise<PayoutResult> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
  })
  if (!provider?.apricotId) {
    throw new Error('PAYOUT_PROVIDER_NOT_MAPPED')
  }

  const warnings: string[] = []

  // Resolve clinic Ext ID for PaymentAllocation
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } })
  const apricotClinicId = clinic?.apricotClinicId ?? null
  if (!apricotClinicId) {
    throw new Error(`診所「${clinic?.name ?? clinicId}」未對應 Apricot ID`)
  }

  // ─── ① Gross from PaymentAllocation ─────────────────────────────────
  const allocWhere: any = {
    ...ACTIVE_ALLOCATION,
    providerExtId: provider.apricotId,
    periodMonth,
    countAsIncome: true,
  }
  if (apricotClinicId) allocWhere.clinicExtId = apricotClinicId

  const allocs = await prisma.paymentAllocation.findMany({ where: allocWhere })

  const rawAmount = round2(sum(allocs.map((a: PaymentAllocation) => Number(a.amount))))
  const grossAmount = round2(sum(allocs.map((a: PaymentAllocation) => Number(a.netAmount))))

  // ─── ② Costs (three categories) ──────────────────────────────────────
  const costWhere: any = {
    providerId,
    periodMonth,
    status: { not: 'VOID' },
    finalCost: { not: null },
  }
  if (clinicId) costWhere.clinicId = clinicId

  const costs = await prisma.costCase.findMany({
    where: costWhere,
    include: { materials: true },
  })

  // Check for unpriced cases (warning)
  const unpricedWhere: any = {
    providerId,
    periodMonth,
    status: { not: 'VOID' },
    baseCost: null,
  }
  if (clinicId) unpricedWhere.clinicId = clinicId
  const unpricedCount = await prisma.costCase.count({ where: unpricedWhere })
  if (unpricedCount > 0) {
    warnings.push(`${unpricedCount} 筆成本記錄未有報價`)
  }

  const labCost = round2(sumByCosts(costs, 'LAB'))
  const implantCost = round2(sumByCosts(costs, 'IMPLANT'))
  const invisalignCost = round2(sumByCosts(costs, 'INVISALIGN'))

  // ─── ③ Profit ────────────────────────────────────────────────────────
  const profitAmount = round2(grossAmount - labCost - implantCost - invisalignCost)

  // ─── ④ Salary = Profit × 拆帳% ───────────────────────────────────────
  const commission = await pickCommission(providerId, periodMonth, clinicId)
  if (!commission) {
    throw new Error('PAYOUT_NO_COMMISSION')
  }
  const percentUsed = Number(commission.percent)
  const salaryAmount = round2(profitAmount * percentUsed / 100)

  // ─── ⑤ SP Subsidy (confirmed only, after ×%, full amount) ────────────
  const spWhere: any = {
    providerId,
    periodMonth,
    status: 'CONFIRMED',
  }
  if (clinicId) spWhere.clinicId = clinicId
  const spSubsidyRecords = await prisma.spSubsidy.findMany({ where: spWhere })
  const spSubsidy = round2(sum(spSubsidyRecords.map((x: any) => Number(x.amount))))

  // ─── ⑥ Referral (full amount) ────────────────────────────────────────
  const refWhere: any = {
    fromProviderId: providerId,
    periodMonth,
    status: 'CONFIRMED', // ★ MD-U: 草稿唔計錢
  }
  if (clinicId) refWhere.clinicId = clinicId
  const refRecords = await prisma.providerReferral.findMany({ where: refWhere })
  const refAmount = round2(sum(refRecords.map((x: any) => Number(x.amount ?? 0))))

  // ─── ⑦ Adjustments (unassigned only) ─────────────────────────────────
  const adjustWhere: any = {
    providerId,
    periodMonth,
    runId: null,
  }
  if (clinicId) adjustWhere.clinicId = clinicId
  const adjustments = await prisma.payoutAdjustment.findMany({ where: adjustWhere })
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
 * ★ 2026-08-17: 加 clinicId 參數。
 */
export async function lockPayoutRun(
  providerId: string,
  periodMonth: string,
  payout: PayoutResult,
  createdBy: string,
  clinicId: string,
): Promise<any> {
  return await basePrisma.$transaction(async (tx: any) => {
    // a. Create PayoutRun with LOCKED status
    const run = await tx.payoutRun.create({
      data: {
        providerId,
        clinicId,
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
    const lockCostWhere: any = {
      providerId,
      periodMonth,
      status: { not: 'VOID' },
      lockedByRunId: null,
    }
    if (clinicId) lockCostWhere.clinicId = clinicId
    await tx.costCase.updateMany({
      where: lockCostWhere,
      data: { lockedByRunId: run.id },
    })

    // c. Lock ProviderReferral
    const lockRefWhere: any = {
      fromProviderId: providerId,
      periodMonth,
      lockedByRunId: null,
    }
    if (clinicId) lockRefWhere.clinicId = clinicId
    await tx.providerReferral.updateMany({
      where: lockRefWhere,
      data: { lockedByRunId: run.id },
    })

    // d. Lock SpSubsidy
    const lockSpWhere: any = {
      providerId,
      periodMonth,
      lockedByRunId: null,
    }
    if (clinicId) lockSpWhere.clinicId = clinicId
    await tx.spSubsidy.updateMany({
      where: lockSpWhere,
      data: { lockedByRunId: run.id },
    })

    // e. Assign unassigned PayoutAdjustment
    const lockAdjWhere: any = {
      providerId,
      periodMonth,
      runId: null,
    }
    if (clinicId) lockAdjWhere.clinicId = clinicId
    await tx.payoutAdjustment.updateMany({
      where: lockAdjWhere,
      data: { runId: run.id },
    })

    // f. Write audit log
    await tx.auditLog.create({
      data: {
        actorId: createdBy,
        action: 'PAYOUT_RUN_LOCK',
        entity: 'PayoutRun',
        entityId: run.id,
        notes: `鎖定月結單：${periodMonth}${clinicId ? ` · 診所 ${clinicId}` : ''}`,
        afterJson: JSON.stringify({
          providerId,
          clinicId,
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
 * ★ MD-K: Pick the most applicable FeeItemListPrice for a given fee item code + bill time.
 */
async function pickListPrice(feeItemCode: string, billTime: Date): Promise<any | null> {
  return prisma.feeItemListPrice.findFirst({
    where: {
      feeItemCode,
      effectiveFrom: { lte: billTime },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: billTime } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  })
}

/**
 * Auto-detect 2-person SP subsidy opportunities from Apricot bill items.
 * ★ 2026-08-17: 加 clinicId 參數（optional）— 傳就只掃該店，唔傳就全部店。
 * ★ MD-K: Uses isSp2p flag (from remarks pattern 2p1k) + FeeItemListPrice table.
 * ★ S1: Two-source detection — isSp2p OR price match from tracked codes.
 * Returns candidates (source='AUTO', status='PENDING') for manual confirmation.
 *
 * 三態 needsReview:
 *   - listPrice ✅ + commission ✅ + actualUnit ≈ SP_2P1K_PER_PERSON → 正常候選
 *   - listPrice ✅ + commission ✅ + actualUnit ≠ SP_2P1K_PER_PERSON → needsReview（金額對唔上）
 *   - listPrice 揾唔到 → needsReview（唔出負數，amount=0）
 */
export async function scanSpSubsidies(
  periodMonth: string,
  clinicId?: string,
): Promise<{ candidates: any[]; skippedLocked: number; created: number; updated: number; failed: { eleId: string; error: string }[] }> {
  const [monthStart, monthEnd] = monthRange(periodMonth)

  // Resolve clinic Ext ID if clinicId is provided
  let apricotClinicId: string | null = null
  if (clinicId) {
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } })
    apricotClinicId = clinic?.apricotClinicId ?? null
  }

  // Build bill where clause
  const billWhere: any = {
    billTime: { gte: monthStart, lte: monthEnd },
    isVoid: false,
  }
  if (apricotClinicId) billWhere.clinicExtId = apricotClinicId

  // S1: 該月生效嘅標準價清單
  const priceRows = await prisma.feeItemListPrice.findMany({
    where: {
      effectiveFrom: { lte: monthEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
    },
  })
  const trackedCodes = [...new Set(priceRows.map(p => p.feeItemCode))]

  // S1: 兩個來源 — isSp2p 標記 OR 標準價有記錄
  const items = await prisma.apricotBillItem.findMany({
    where: {
      bill: billWhere,
      OR: [
        { isSp2p: true }, // A: remarks 有 2P1K
        { feeItemCode: { in: trackedCodes } }, // B: 標準價有記錄
      ],
    },
    include: { bill: true },
  })

  const candidates: any[] = []
  let skippedLocked = 0
  let created = 0
  let updated = 0
  const failed: { eleId: string; error: string }[] = []

  for (const item of items) {
    try {
      const bill: any = (item as any).bill
      const provider = bill.providerExtId
        ? await prisma.provider.findUnique({
            where: { apricotId: bill.providerExtId! },
          })
        : null

      if (!provider) continue

      // Resolve clinic from bill's clinicExtId
      const billClinic = apricotClinicId
        ? null // already filtered
        : bill.clinicExtId
          ? await prisma.clinic.findFirst({
              where: { apricotClinicId: bill.clinicExtId },
            })
          : null

      // F5: Fetch per-provider split% from commission
      const commission = await pickCommission(provider.id, periodMonth, billClinic?.id)
      const pct = commission ? Number(commission.percent) : null

      // ★ MD-K: Pick list price from FeeItemListPrice table
      const listPriceRow = await pickListPrice(item.feeItemCode, bill.billTime)
      const listPriceNum = listPriceRow ? Number(listPriceRow.listPrice) : null

      const qty = item.qty || 1
      // 折後實收單價（直接填 500 或 580 打折扣都出 500）
      const actualUnit = round2(Number(item.ttlAmt) / qty)

      // S1: 雙來源篩選
      const hasListPrice = listPriceNum != null
      const hasCommission = pct != null
      const priceMatches = Math.abs(actualUnit - SP_2P1K_PER_PERSON) < 0.01

      // 兩個來源都唔中 → 唔係候選
      if (!item.isSp2p && !priceMatches) continue

      // S1: hasMarker — 有沒有 2P1K 備註標記
      const hasMarker = item.isSp2p

      let amount: number
      let needsReview: boolean = false

      // 冇標記但金額啱 → needsReview
      needsReview = needsReview || !hasMarker

      if (!hasListPrice) {
        // 標準價揾唔到 → needsReview，唔出負數
        amount = 0
        needsReview = true
      } else if (!hasCommission) {
        // 拆帳%冇設定 → needsReview
        amount = 0
        needsReview = true
      } else if (!priceMatches) {
        // 金額對唔上 → 產生候選 + needsReview
        const raw = (listPriceNum - actualUnit) * (pct / 100) * qty
        amount = round2(Math.max(0, raw)) // ★ 唔准負
        needsReview = needsReview || raw < 0
      } else {
        // 正常候選
        amount = round2((listPriceNum - actualUnit) * (pct / 100) * qty)
      }

      const actualPrice = actualUnit
      const listPriceUsed = hasListPrice ? listPriceNum : actualPrice

      // Upsert: get or create
      const existing = await prisma.spSubsidy.findUnique({
        where: { billItemEleId: item.eleId },
      }).catch(() => null)

      // R4: 已出月結，唔准動
      if (existing?.lockedByRunId) { skippedLocked++; continue }

      // Build update data — T1: billItemEleId must be included for create
      const updateData: any = {
        billItemEleId: item.eleId, // ★ T1: required for create
        providerId: provider.id,
        clinicId: billClinic?.id || null,
        billExtId: bill.extId,
        itemDes: item.feeItemDes,
        listPrice: new Prisma.Decimal(String(listPriceUsed)),
        actualPrice: new Prisma.Decimal(String(actualPrice)),
        headcount: qty,
        splitPercent: pct != null ? new Prisma.Decimal(String(pct)) : new Prisma.Decimal('0'),
        amount: new Prisma.Decimal(String(amount)),
        // source：唔好蓋走人手建立嘅
        ...(existing?.source === 'MANUAL' ? {} : { source: 'AUTO' }),
        // S3: 金額變咗先要重新設定 PENDING；SKIPPED 唔覆蓋
        ...(existing ? (() => {
          const amountChanged = Number(existing.amount) !== amount
          return amountChanged ? { status: 'PENDING', confirmedBy: null } : {}
        })() : {}),
        // S1: hasMarker
        hasMarker,
        needsReview,
        periodMonth,
      }

      // assertRequired: check all required fields before create
      const REQUIRED_SP = ['providerId', 'billExtId', 'billItemEleId', 'itemDes', 'listPrice', 'actualPrice', 'splitPercent', 'amount', 'periodMonth']
      const missing = REQUIRED_SP.filter(k => (updateData as any)[k] == null)
      if (missing.length) throw new Error(`SpSubsidy 缺必填欄：${missing.join(', ')}`)

      if (existing) {
        await prisma.spSubsidy.update({
          where: { billItemEleId: item.eleId },
          data: updateData,
        })
        updated++
      } else {
        await prisma.spSubsidy.create({
          data: {
            ...updateData,
            source: 'AUTO',
            status: 'PENDING',
            confirmedBy: null,
          },
        })
        created++
      }

      candidates.push({
        providerId: provider.id,
        clinicId: billClinic?.id || null,
        itemDes: item.feeItemDes,
        listPrice: listPriceUsed,
        actualPrice,
        headcount: qty,
        splitPercent: pct ?? 0,
        amount,
        needsReview,
        hasMarker,
        source: 'AUTO',
        status: existing?.lockedByRunId ? 'PENDING' : (existing ? existing.status : 'PENDING'),
        confirmedBy: null,
        periodMonth,
      })
    } catch (e: any) {
      console.error('[scan] item 失敗', item.eleId, e?.message)
      failed.push({ eleId: item.eleId, error: String(e?.message).slice(0, 200) })
    }
  }

  return { candidates, skippedLocked, created, updated, failed }
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
  clinicId: string,
): Promise<any> {
  return await prisma.payoutAdjustment.create({
    data: {
      providerId,
      clinicId,
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
