// ============================================================
// ★ cwm-kioskpayout-20261010：店舖帳號（KIOSK）做醫生月結 —— 只限自己綁定嘅店
//
// 背景：KIOSK 經 provider_payout 權限入醫生月結，requireAuth／requirePerm 會將 scope 提升到 'all'
//   （provider_payout 係跨店概念，老闆／後勤要跨店出糧）。但店舖帳號係店舖公開裝置：
//   老闆 2026-10-10：「TMY 嘅店唔可以月結 YL 嘅醫生」→ KIOSK 一律收窄到 UserClinic 綁定嘅店。
//   role 判斷全部喺呢度（route 唔准寫死角色：check-role-hardcode-api.sh）。
//
// fail-closed：KIOSK 冇綁任何店 = 乜都做唔到（唔同 daily-check kioskClinicAllowed 嘅「冇綁 = 唔限」）。
// 其他角色：null = 唔額外收窄（照 route 原有權限）。
// ============================================================

type ScopeSession = { role: string; clinics?: string[] | null }

export const PAYOUT_CLINIC_FORBIDDEN = '店舖帳號只可以處理自己間店嘅醫生月結'

/** KIOSK → 綁定嘅店清單（可能係 []）；其他角色 → null（唔收窄） */
export function payoutClinicLimit(session: ScopeSession): string[] | null {
  return session.role === 'KIOSK' ? [...(session.clinics ?? [])] : null
}

/** 呢個 clinicId 准唔准（KIOSK：一定要有 clinicId 而且係自己店） */
export function payoutClinicAllowed(session: ScopeSession, clinicId: string | null | undefined): boolean {
  const lim = payoutClinicLimit(session)
  if (!lim) return true
  return !!clinicId && lim.includes(clinicId)
}

/** route 用：唔准 → 403 Response；准 → null */
export function payoutClinicGuard(session: ScopeSession, clinicId: string | null | undefined): Response | null {
  return payoutClinicAllowed(session, clinicId)
    ? null
    : Response.json({ error: PAYOUT_CLINIC_FORBIDDEN }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
}

/** Prisma where 片段：KIOSK → { clinicId: { in: 自己店 } }（指定咗 clinicId 就交返 guard 判斷）；其他 → {} */
export function payoutClinicWhere(session: ScopeSession, field = 'clinicId'): Record<string, unknown> {
  const lim = payoutClinicLimit(session)
  return lim ? { [field]: { in: lim } } : {}
}

/**
 * 按記錄嘅 clinicId 判斷（by-id route 用）。非 KIOSK 唔查 DB、直接通過（行為零改變）；
 * 記錄唔存在 → null（交返 route 原有 404／錯誤處理）。
 */
export async function payoutRecordGuard(
  session: ScopeSession,
  load: () => Promise<{ clinicId: string | null } | null>,
): Promise<Response | null> {
  if (!payoutClinicLimit(session)) return null
  const rec = await load()
  if (!rec) return null
  return payoutClinicGuard(session, rec.clinicId)
}

/**
 * 醫生轉介草稿未有帳單 → clinicId = null（未屬任何店、唔會計入任何月結）—— 准；有店就要係自己店。
 */
export function payoutClinicGuardDraft(session: ScopeSession, clinicId: string | null | undefined): Response | null {
  return clinicId == null ? null : payoutClinicGuard(session, clinicId)
}
