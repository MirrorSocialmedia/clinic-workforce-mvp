import { Prisma } from '@prisma/client'
import type { PaymentMethodRule } from '@prisma/client'
import { toHKDateStr } from './hk-date'
import { resolveMethodRule } from './apricot/allocate'
import { normalizeMethod } from './apricot/normalize'
import { getOwnHomeClinicId } from './scope-helpers'

/**
 * cwm-payoutxlsx-20260908 D2 — 店舖雜項收入（唔經 Apricot 嘅收入）。
 * 共用驗證／scope／序列化：api/misc-income/route.ts + api/misc-income/[id]/route.ts。
 */

export const MISC_INCOME_CATEGORIES = ['PRODUCT', 'DEPOSIT', 'OTHER'] as const
export type MiscIncomeCategory = (typeof MISC_INCOME_CATEGORIES)[number]

/** 可驗證嘅欄（create 傳 body；PUT 傳 merge 後嘅 effective 值） */
export interface MiscIncomeInput {
  clinicId?: unknown
  incomeAt?: unknown
  category?: unknown
  itemName?: unknown
  note?: unknown
  methodNorm?: unknown
  amount?: unknown
}

export interface MiscIncomeValidated {
  clinicId: string
  incomeAt: Date
  category: MiscIncomeCategory
  itemName: string
  note: string | null
  methodNorm: string
  /** 已 round 2dp */
  amount: number
  /** ★ 恆由 incomeAt（HK 時區）derive —— 唔准由前端傳 */
  periodMonth: string
}

/**
 * 驗證雜項收入 create/update 欄。
 *
 * ★ MD D2 鐵律：
 * · `periodMonth` 前端傳都忽略 —— 一律 `toHKDateStr(incomeAt).slice(0, 7)`（同 CostCase 口徑）
 * · `methodNorm` 必須喺 `PaymentMethodRule` resolve 到，否則 400
 *   （唔准靜靜當 0% —— AE 嗰課：未知方式一定要有出口）
 * · `amount` > 0；`itemName` ≤ 100 字；`note` ≤ 200 字；`category` ∈ PRODUCT/DEPOSIT/OTHER
 *
 * @param allRules 全部 PaymentMethodRule（route 端 fetch 一次傳入）
 */
export function validateMiscIncome(
  input: MiscIncomeInput,
  allRules: PaymentMethodRule[],
): { ok: true; data: MiscIncomeValidated } | { ok: false; error: string } {
  const clinicId = typeof input.clinicId === 'string' ? input.clinicId.trim() : ''
  if (!clinicId) return { ok: false, error: '診所必選' }

  const incomeAtRaw = input.incomeAt
  const incomeAt =
    incomeAtRaw instanceof Date
      ? incomeAtRaw
      : typeof incomeAtRaw === 'string' || typeof incomeAtRaw === 'number'
        ? new Date(incomeAtRaw as string | number)
        : null
  if (!incomeAt || isNaN(incomeAt.getTime())) {
    return { ok: false, error: '收款時間格式錯誤' }
  }

  const category = typeof input.category === 'string' ? input.category : ''
  if (!(MISC_INCOME_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, error: '類別必須係 PRODUCT / DEPOSIT / OTHER' }
  }

  const itemName = typeof input.itemName === 'string' ? input.itemName.trim() : ''
  if (!itemName) return { ok: false, error: '項目必填' }
  if (itemName.length > 100) return { ok: false, error: '項目最多 100 字' }

  let note: string | null = null
  if (input.note != null && input.note !== '') {
    if (typeof input.note !== 'string') return { ok: false, error: '備註格式錯誤' }
    note = input.note
    if (note.length > 200) return { ok: false, error: '備註最多 200 字' }
  }

  const methodRaw = typeof input.methodNorm === 'string' ? input.methodNorm.trim() : ''
  if (!methodRaw) return { ok: false, error: '付款方式必選' }
  // 同 PaymentAllocation.methodNorm 同一口徑（lib/apricot/normalize.ts）
  const methodNorm = normalizeMethod(methodRaw)
  // ★ 必須 resolve 到規則 —— 無匹配規則 = needsReview = 400（唔准靜默默認 0%）
  const rule = resolveMethodRule(methodNorm, incomeAt, allRules)
  if (rule.needsReview) {
    return { ok: false, error: `付款方式 ${methodNorm} 冇對應規則` }
  }

  const amountRaw = input.amount
  const amountNum =
    amountRaw instanceof Prisma.Decimal
      ? Number(amountRaw)
      : typeof amountRaw === 'number'
        ? amountRaw
        : typeof amountRaw === 'string' && amountRaw.trim() !== ''
          ? Number(amountRaw)
          : NaN
  if (!isFinite(amountNum) || amountNum <= 0) {
    return { ok: false, error: '金額必須大於 0' }
  }
  const amount = Math.round(amountNum * 100) / 100

  return {
    ok: true,
    data: {
      clinicId,
      incomeAt,
      category: category as MiscIncomeCategory,
      itemName,
      note,
      methodNorm,
      amount,
      // ★ HK 時區導出 —— 同 CostCase.periodMonth 同一慣例
      periodMonth: toHKDateStr(incomeAt).slice(0, 7),
    },
  }
}

/**
 * 寫入用 clinic scope（fail-closed）—— 同 scope-helpers 慣例：
 * `null` = 唔限制（scope 'all'）；`string[]` = 可寫診所（空 = 乜都寫唔到）。
 */
export async function miscIncomeScopeClinics(
  session: { userId: string },
  scope: 'all' | 'my-clinics' | 'self',
  sessionClinics: string[] | undefined,
): Promise<string[] | null> {
  if (scope === 'all') return null
  if (scope === 'my-clinics') return sessionClinics ?? []
  // 'self'（EMPLOYEE/KIOSK 經 cost_entry 權限）→ 淨主屬店
  const home = await getOwnHomeClinicId(session.userId)
  return home ? [home] : []
}

export interface MiscIncomeRow {
  id: string
  clinicId: string
  incomeAt: Date
  category: string
  itemName: string
  note: string | null
  methodNorm: string
  amount: Prisma.Decimal | number
  periodMonth: string
  isVoid: boolean
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

/** 回應序列化（Decimal → number） */
export function serializeMiscIncome(r: MiscIncomeRow) {
  return {
    id: r.id,
    clinicId: r.clinicId,
    incomeAt: r.incomeAt,
    category: r.category,
    itemName: r.itemName,
    note: r.note,
    methodNorm: r.methodNorm,
    amount: Number(r.amount),
    periodMonth: r.periodMonth,
    isVoid: r.isVoid,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}
