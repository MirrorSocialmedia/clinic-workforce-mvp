import { Prisma, PaymentMethodRule } from '@prisma/client'
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
  isVoid?: boolean
}

interface RuleResult {
  feePercent: number
  countAsIncome: boolean
  needsReview: boolean
}

/** 解決 PaymentMethodRule — 按 method + paidAt resolve (pure function, rules from cache) */
function resolveMethodRule(methodNorm: string, paidAt: Date, allRules: PaymentMethodRule[]): RuleResult {
  const applicable = allRules
    .filter(r =>
      r.method === methodNorm &&
      r.effectiveFrom <= paidAt &&
      (!r.effectiveTo || r.effectiveTo >= paidAt)
    )
    .sort((a, b) =>
      b.effectiveFrom.getTime() - a.effectiveFrom.getTime() ||
      b.id.localeCompare(a.id)
    )

  if (applicable.length === 0) {
    return { feePercent: 0, countAsIncome: true, needsReview: true }
  }
  const rule = applicable[0]
  return {
    feePercent: Number(rule.feePercent),
    countAsIncome: rule.countAsIncome,
    needsReview: false,
  }
}

/** 計算 netAmount = amount * (1 - feePercent / 100) */
function computeNet(amount: number, feePercent: number): number {
  return Math.round(amount * (1 - feePercent / 100) * 100) / 100
}

/** 四捨五入補平 — 最後一行補差，保證 Σ(amount) === totalAmt */
function roundWithAdjustment(allocations: PaymentAllocationRow[], totalAmt: number, paymentExtId: string): PaymentAllocationRow[] {
  let sum = 0
  const rounded = allocations.map(a => {
    const amt = Math.round(a.amount * 100) / 100
    sum += amt
    return { ...a, amount: amt }
  })

  const total = Math.round(totalAmt * 100) / 100
  const diff = Math.round((total - sum) * 100) / 100
  if (diff !== 0 && rounded.length > 0) {
    const last = rounded[rounded.length - 1]
    last.amount = Math.round((last.amount + diff) * 100) / 100
    // C4: 補平後重算 netAmount
    last.netAmount = computeNet(last.amount, last.feePercentUsed)

    // C2: 安全網 — 補平差額 > $1 標 needsReview
    if (Math.abs(diff) > 1) {
      console.error('[apricot] 補平差額異常', { paymentExtId, diff, sum, total })
      rounded.forEach(r => { r.needsReview = true })
    }
  }

  return rounded
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
 * @param bills bill cache (Map<billExtId, bill>) — DB Prisma shape
 * @param clinicExtId clinic external ID
 * @param allRefs 全歷史 refs（用於 RECON 判斷）— C3: 無 default
 * @param allRules 所有 payment method rules（用於 resolve）
 */
export async function allocatePayment(
  payment: any,
  methods: Array<{ methodRaw: string; methodNorm: string; amount: Prisma.Decimal | number; payType: string }>,
  refs: Array<{ billExtId: string; billCode: string; amount: Prisma.Decimal | number }>,
  bills: Map<string, any>,
  clinicExtId: string,
  allRefs: Array<{ billExtId: string }>, // ★ C3: 無 default，逼 caller 傳
  allRules: PaymentMethodRule[],
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
    const rule = resolveMethodRule(methodNorm, paidAt, allRules)

    allocations.push({
      paymentExtId: payment.id,
      billExtId: refs[0].billExtId,
      providerExtId: bill?.providerExtId ?? null, // C1: DB shape
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

      // C1: DB shape — bill.items + JSON.parse(item.reconJson)
      const billItems = bill.items || []
      const reconDetails = billItems.flatMap((item: any) => {
        const reconData = item.reconJson
        if (!reconData) return []
        const parsed = typeof reconData === 'string' ? JSON.parse(reconData) : reconData
        return (Array.isArray(parsed) ? parsed : []).map((r: any) => ({
          des: r.des || '',
          amt: Number(r.amt ?? 0),
        }))
      })

      if (reconDetails.length > 0) {
        // Group recon by method description
        const reconByMethod = new Map<string, number>()
        for (const rd of reconDetails) {
          const norm = normalizeMethod(rd.des)
          reconByMethod.set(norm, (reconByMethod.get(norm) ?? 0) + rd.amt)
        }

        // C2: 驗證 recon 總額是否等於 ref 金額
        const reconTotal = [...reconByMethod.values()].reduce((s, v) => s + v, 0)
        const refAmt = Number(ref.amount ?? 0)
        if (Math.abs(reconTotal - refAmt) > 0.01) {
          // 對唔上 → 走 PRORATA
          // push PRORATA 行
          for (const method of methods) {
            const methodNorm = method.methodNorm
            const rule = resolveMethodRule(methodNorm, paidAt, allRules)
            const proportion = Number(method.amount ?? 0) / totalAmt
            const allocAmt = totalAmt === 0 ? 0 : refAmt * proportion

            allocations.push({
              paymentExtId: payment.id,
              billExtId: ref.billExtId,
              providerExtId: bill.providerExtId ?? null, // C1: DB shape
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
          continue
        }

        for (const [norm, reconAmt] of reconByMethod.entries()) {
          if (reconAmt <= 0) continue
          const rule = resolveMethodRule(norm, paidAt, allRules)
          allocations.push({
            paymentExtId: payment.id,
            billExtId: ref.billExtId,
            providerExtId: bill.providerExtId ?? null, // C1: DB shape
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
          const rule = resolveMethodRule(methodNorm, paidAt, allRules)
          // Split ref amount proportionally by method
          const proportion = Number(method.amount ?? 0) / totalAmt
          const allocAmt = totalAmt === 0 ? 0 : refAmt * proportion

          allocations.push({
            paymentExtId: payment.id,
            billExtId: ref.billExtId,
            providerExtId: bill.providerExtId ?? null, // C1: DB shape
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
      const rule = resolveMethodRule(methodNorm, paidAt, allRules)
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
          providerExtId: bill?.providerExtId ?? null, // C1: DB shape
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

  // ★ E1：按 (billExtId, methodNorm) 合併，防止 unique key 撞覆蓋
  const merged = new Map<string, PaymentAllocationRow>()
  for (const a of allocations) {
    const k = `${a.billExtId}|${a.methodNorm}`
    const ex = merged.get(k)
    if (ex) {
      ex.amount += a.amount
      ex.netAmount = computeNet(ex.amount, ex.feePercentUsed)
    } else {
      merged.set(k, { ...a })
    }
  }

  // 四捨五入補平
  return roundWithAdjustment([...merged.values()], totalAmt, payment.id)
}

/** 批量寫入 PaymentAllocation（upsert by unique key） */
export async function upsertAllocations(allocations: PaymentAllocationRow[]) {
  if (allocations.length === 0) return

  // ★ E2：updateMany + upsert 包入 $transaction，防止中斷後所有行永久 isSuperseded=true
  const paymentExtIds = [...new Set(allocations.map(a => a.paymentExtId))]
  for (const pid of paymentExtIds) {
    await prisma.$transaction(async tx => {
      await tx.paymentAllocation.updateMany({
        where: { paymentExtId: pid },
        data: { isSuperseded: true },
      })

      for (const a of allocations.filter(x => x.paymentExtId === pid)) {
        await tx.paymentAllocation.upsert({
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
            isVoid: a.isVoid ?? false,
            isSuperseded: false,
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
            isVoid: a.isVoid ?? false,
            isSuperseded: false,
          },
        })
      }
    })
  }
}
