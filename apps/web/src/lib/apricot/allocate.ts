import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { normalizeMethod } from './normalize'

interface PaymentAllocationRow {
  paymentExtId: string
  billExtId: string
  providerExtId: string | null
  clinicExtId: string
  paidAt: Date
  periodMonth: string
  methodNorm: string
  amount: number
  feePercentUsed: number
  netAmount: number
  countAsIncome: boolean
  allocationMode: 'DIRECT' | 'RECON' | 'PRORATA'
  needsReview: boolean
}

/** 解決 PaymentMethodRule — 按 method + paidAt resolve */
async function resolveMethodRule(methodNorm: string, paidAt: Date) {
  const rule = await prisma.paymentMethodRule.findFirst({
    where: {
      method: methodNorm,
      effectiveFrom: { lte: paidAt },
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gte: paidAt } },
      ],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  })

  if (!rule) {
    return { feePercent: 0, countAsIncome: true, needsReview: true }
  }
  return {
    feePercent: Number(rule.feePercent),
    countAsIncome: rule.countAsIncome,
    needsReview: false,
  }
}

/** 四捨五入補平 — 最後一行補差，保證 Σ(amount) === totalAmt */
function roundWithAdjustment(allocations: PaymentAllocationRow[], totalAmt: number): PaymentAllocationRow[] {
  let sum = 0
  const rounded = allocations.map(a => {
    const amt = Math.round(a.amount * 100) / 100
    sum += amt
    return { ...a, amount: amt }
  })

  const total = Math.round(totalAmt * 100) / 100
  const diff = Math.round((total - sum) * 100) / 100
  if (diff !== 0 && rounded.length > 0) {
    rounded[rounded.length - 1].amount += diff
  }

  return rounded
}

/**
 * 計算 netAmount = amount * (1 - feePercentUsed / 100)
 */
function computeNet(amount: number, feePercent: number): number {
  return Math.round(amount * (1 - feePercent / 100) * 100) / 100
}

/** 檢查一個 billExtId 喺全部 PaymentRef 入面只出現過一次 */
function isBillUniqueInRefs(billExtId: string, allRefs: Array<{ billExtId: string }>): boolean {
  return allRefs.filter(r => r.billExtId === billExtId).length === 1
}

/**
 * 三個 mode 分配：DIRECT / RECON / PRORATA
 * @param payment 已 sanitize 嘅 payment 資料
 * @param methods normalized payment methods
 * @param refs payment refs (bill references)
 * @param bills bill cache (Map<billExtId, bill>)
 */
export async function allocatePayment(
  payment: any,
  methods: Array<{ methodRaw: string; methodNorm: string; amount: Prisma.Decimal | number; payType: string }>,
  refs: Array<{ billExtId: string; billCode: string; amount: Prisma.Decimal | number }>,
  bills: Map<string, any>,
  clinicExtId: string,
  allRefs: Array<{ billExtId: string }> = refs.map(r => ({ billExtId: r.billExtId })),
): Promise<PaymentAllocationRow[]> {
  const allocations: PaymentAllocationRow[] = []
  const paidAt = new Date(payment.paymentTime)
  const periodMonth = toHKDateStr(payment.paymentTime).slice(0, 7)
  const totalAmt = Number(payment.amt ?? 0)

  // Load all methods into a map for RECON matching
  const methodNorms = methods.map(m => m.methodNorm)
  const uniqueMethods = [...new Set(methodNorms)]

  // ── Mode 1: DIRECT — 一個方式 + 一張單 ──
  if (methods.length === 1 && refs.length === 1) {
    const bill = bills.get(refs[0].billExtId)
    const methodNorm = methods[0].methodNorm
    const rule = await resolveMethodRule(methodNorm, paidAt)

    allocations.push({
      paymentExtId: payment.id,
      billExtId: refs[0].billExtId,
      providerExtId: bill?.practitioner?.id ?? null,
      clinicExtId: clinicExtId,
      paidAt,
      periodMonth,
      methodNorm,
      amount: totalAmt,
      feePercentUsed: rule.feePercent,
      netAmount: computeNet(totalAmt, rule.feePercent),
      countAsIncome: rule.countAsIncome,
      allocationMode: 'DIRECT',
      needsReview: rule.needsReview,
    })
  }
  // ── Mode 2: RECON — 用 bill item 層嘅 reconPaymentDetails ──
  // 條件：每個 billExtId 喺 PaymentRef 入面只出現過一次 + billDetails 有 reconPaymentDetails
  else if (refs.every(r => isBillUniqueInRefs(r.billExtId, allRefs))) {
    for (const ref of refs) {
      const bill = bills.get(ref.billExtId)
      if (!bill) continue

      const billDetails = bill.billDetails || []
      const reconDetails = billDetails.flatMap((d: any) => (d.reconPaymentDetails || []).map((r: any) => ({
        des: r.des || '',
        amt: Number(r.amt ?? 0),
      })))

      if (reconDetails.length > 0) {
        // Group recon by method description
        const reconByMethod = new Map<string, number>()
        for (const rd of reconDetails) {
          const norm = normalizeMethod(rd.des)
          reconByMethod.set(norm, (reconByMethod.get(norm) ?? 0) + rd.amt)
        }

        for (const [norm, reconAmt] of reconByMethod.entries()) {
          if (reconAmt <= 0) continue
          const rule = await resolveMethodRule(norm, paidAt)
          allocations.push({
            paymentExtId: payment.id,
            billExtId: ref.billExtId,
            providerExtId: bill.practitioner?.id ?? null,
            clinicExtId: clinicExtId,
            paidAt,
            periodMonth,
            methodNorm: norm,
            amount: reconAmt,
            feePercentUsed: rule.feePercent,
            netAmount: computeNet(reconAmt, rule.feePercent),
            countAsIncome: rule.countAsIncome,
            allocationMode: 'RECON',
            needsReview: rule.needsReview,
          })
        }
      } else {
        // No recon data — fall through to PRORATA per ref
        const refAmt = Number(ref.amount ?? 0)
        for (const method of methods) {
          const methodNorm = method.methodNorm
          const rule = await resolveMethodRule(methodNorm, paidAt)
          // Split ref amount proportionally by method
          const proportion = Number(method.amount ?? 0) / totalAmt
          const allocAmt = totalAmt === 0 ? 0 : refAmt * proportion

          allocations.push({
            paymentExtId: payment.id,
            billExtId: ref.billExtId,
            providerExtId: bill.practitioner?.id ?? null,
            clinicExtId: clinicExtId,
            paidAt,
            periodMonth,
            methodNorm,
            amount: allocAmt,
            feePercentUsed: rule.feePercent,
            netAmount: computeNet(allocAmt, rule.feePercent),
            countAsIncome: rule.countAsIncome,
            allocationMode: 'PRORATA',
            needsReview: rule.needsReview,
          })
        }
      }
    }
  }
  // ── Mode 3: PRORATA — 按金額比例攤（fallback） ──
  else {
    for (const method of methods) {
      const methodNorm = method.methodNorm
      const methodAmt = Number(method.amount ?? 0)
      const rule = await resolveMethodRule(methodNorm, paidAt)
      const proportion = totalAmt === 0 ? 1 / methods.length : methodAmt / totalAmt

      for (const ref of refs) {
        const bill = bills.get(ref.billExtId)
        const refAmt = Number(ref.amount ?? 0)
        // Split: (method proportion) * (ref proportion) * total
        const refProportion = totalAmt === 0 ? 1 / refs.length : refAmt / totalAmt
        const allocAmt = totalAmt * proportion * refProportion

        allocations.push({
          paymentExtId: payment.id,
          billExtId: ref.billExtId,
          providerExtId: bill?.practitioner?.id ?? null,
          clinicExtId: clinicExtId,
          paidAt,
          periodMonth,
          methodNorm,
          amount: allocAmt,
          feePercentUsed: rule.feePercent,
          netAmount: computeNet(allocAmt, rule.feePercent),
          countAsIncome: rule.countAsIncome,
          allocationMode: 'PRORATA',
          needsReview: rule.needsReview,
        })
      }
    }
  }

  // 四捨五入補平
  return roundWithAdjustment(allocations, totalAmt)
}

/** 批量寫入 PaymentAllocation（upsert by unique key） */
export async function upsertAllocations(allocations: PaymentAllocationRow[]) {
  if (allocations.length === 0) return

  // Delete existing allocations for same paymentExtId to avoid conflicts
  const paymentExtIds = [...new Set(allocations.map(a => a.paymentExtId))]
  for (const pid of paymentExtIds) {
    await prisma.paymentAllocation.updateMany({
      where: { paymentExtId: pid, isVoid: false },
      data: { isVoid: true },
    })
  }

  for (const a of allocations) {
    await prisma.paymentAllocation.upsert({
      where: {
        paymentExtId_billExtId_methodNorm: {
          paymentExtId: a.paymentExtId,
          billExtId: a.billExtId,
          methodNorm: a.methodNorm,
        },
      },
      update: {
        providerExtId: a.providerExtId,
        clinicExtId: a.clinicExtId,
        paidAt: a.paidAt,
        periodMonth: a.periodMonth,
        amount: new Prisma.Decimal(String(a.amount)),
        feePercentUsed: new Prisma.Decimal(String(a.feePercentUsed)),
        netAmount: new Prisma.Decimal(String(a.netAmount)),
        countAsIncome: a.countAsIncome,
        allocationMode: a.allocationMode,
        needsReview: a.needsReview,
        isVoid: false,
        computedAt: new Date(),
      },
      create: {
        paymentExtId: a.paymentExtId,
        billExtId: a.billExtId,
        providerExtId: a.providerExtId,
        clinicExtId: a.clinicExtId,
        paidAt: a.paidAt,
        periodMonth: a.periodMonth,
        methodNorm: a.methodNorm,
        amount: new Prisma.Decimal(String(a.amount)),
        feePercentUsed: new Prisma.Decimal(String(a.feePercentUsed)),
        netAmount: new Prisma.Decimal(String(a.netAmount)),
        countAsIncome: a.countAsIncome,
        allocationMode: a.allocationMode,
        needsReview: a.needsReview,
        isVoid: false,
      },
    })
  }
}
