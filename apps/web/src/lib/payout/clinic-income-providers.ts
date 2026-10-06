/**
 * lib/payout/clinic-income-providers.ts — 診所 × 月份 → 有收入嘅醫生（唯一來源）
 *
 * ★ cwm-draftreport-20261006：由 api/payout-runs/clinics（providersForClinic 1–2 步）原封抽出，
 *   全店月報（clinic-report）都要知「邊個醫生有收入但未鎖定」— 兩邊各寫一次 = 將來改一邊就漏人。
 *   兩個來源：
 *     PaymentAllocation（付款，經 apricotClinicId ↔ clinicExtId → ApricotPractitioner kind=PROVIDER）
 *     ProviderReferral（轉介，clinicId = 實際做／收錢嗰間，2026-08-16 拍板）
 * ★★ isActive 唔准 filter —— 停用咗嘅醫生一樣可能有上個月收入要出月結。
 */
import { ACTIVE_ALLOCATION } from '@/lib/payout/engine'

export async function incomeProviderIds(
  db: any,
  clinic: { id: string; apricotClinicId: string | null },
  periodMonth: string,
): Promise<{ allocIds: Set<string>; refIds: Set<string> }> {
  // 1. 有付款收入
  let allocExtIds: string[] = []
  if (clinic.apricotClinicId) {
    const rows = await db.paymentAllocation.findMany({
      where: {
        clinicExtId: clinic.apricotClinicId,
        periodMonth,
        ...ACTIVE_ALLOCATION,
      },
      select: { providerExtId: true },
      distinct: ['providerExtId'],
    })
    allocExtIds = rows.map((r: { providerExtId: string | null }) => r.providerExtId).filter(Boolean) as string[]
  }
  // ★ C 章：反查經 ApricotPractitioner —— 只認 kind=PROVIDER；CLINIC／UNKNOWN 帳號唔係醫生
  const practitioners = allocExtIds.length > 0
    ? await db.apricotPractitioner.findMany({
        where: { apricotId: { in: allocExtIds }, kind: 'PROVIDER' },
        select: { providerId: true },
      })
    : []
  const practitionerProviderIds = [...new Set(practitioners.map((p: { providerId: string | null }) => p.providerId).filter(Boolean))] as string[]
  // 帳號綁咗但 Provider 已刪 → 唔當醫生（同舊 route 經 provider.findMany 過濾一致）
  const existing = practitionerProviderIds.length > 0
    ? await db.provider.findMany({ where: { id: { in: practitionerProviderIds } }, select: { id: true } })
    : []
  const allocIds = new Set<string>(existing.map((p: { id: string }) => p.id))

  // 2. 有轉介收入
  const refRows = await db.providerReferral.findMany({
    where: { clinicId: clinic.id, periodMonth },
    select: { fromProviderId: true },
    distinct: ['fromProviderId'],
  })
  const refIds = new Set<string>(refRows.map((r: { fromProviderId: string }) => r.fromProviderId))

  return { allocIds, refIds }
}
