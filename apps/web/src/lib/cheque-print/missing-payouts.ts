// ============================================================
// ★ cwm-chequerec-20261005：支票中心「醫生」分頁 —— 未生成月結嘅醫生都要見到
//   舊版只列已生成嘅 PayoutRun → 一張都未生成就顯示「醫生 0」，老闆以為冇嘢要出。
//   而家：喺呢個戶口診所執業（ProviderClinic）、而家 active、但呢個月喺嗰間店未有 PayoutRun 嘅醫生
//   → 出一行灰色「未生成月結」（blocker 有值 → resolveSource 一律擋，唔會出到票）。
//   純函數（唔掂 DB），方便單元測試。
// ============================================================

export interface MissingPayoutInput {
  /** 呢個戶口用緊嘅診所 */
  clinicIds: string[]
  /** 醫生 × 診所（ProviderClinic），只傳 active 醫生 */
  assignments: Array<{ providerId: string; clinicId: string }>
  /** 呢個月已生成嘅 PayoutRun（任何狀態） */
  payouts: Array<{ providerId: string; clinicId: string }>
}

export const MISSING_PAYOUT_PREFIX = 'missing:'
export const MISSING_PAYOUT_BLOCKER = '未生成月結（去「醫生拆帳」生成）'

/** 回傳要補「未生成月結」行嘅（providerId, clinicId），已去重 */
export function missingPayouts(input: MissingPayoutInput): Array<{ providerId: string; clinicId: string }> {
  const clinics = new Set(input.clinicIds)
  const have = new Set(input.payouts.map(p => `${p.providerId}|${p.clinicId}`))
  const seen = new Set<string>()
  const out: Array<{ providerId: string; clinicId: string }> = []
  for (const a of input.assignments) {
    if (!clinics.has(a.clinicId)) continue
    const k = `${a.providerId}|${a.clinicId}`
    if (have.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push({ providerId: a.providerId, clinicId: a.clinicId })
  }
  return out
}

/** 佔位行 sourceId（唔係真 PayoutRun id —— 出票時 resolveSource 會因 blocker 擋） */
export const missingSourceId = (providerId: string, clinicId: string) => `${MISSING_PAYOUT_PREFIX}${providerId}|${clinicId}`
export const isMissingSourceId = (id: string) => id.startsWith(MISSING_PAYOUT_PREFIX)
