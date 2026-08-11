import { prisma } from './prisma'

/**
 * 醫生當值表嘅診所範圍。
 *
 * ★ 特登唔用 resolveClinicScope —— 嗰個對 MANAGER 一律 return null（全公司），
 * 係 2026-08-03 為咗考勤跨店調鋪而定嘅。醫生當值表要求收窄到主屬店，
 * 語義相反，所以獨立一個 function。
 *
 * @returns null = 全部診所（OWNER）；string[] = 只限呢啲；[] = 冇任何範圍（fail-closed）
 */
export async function resolveProviderScheduleScope(
  session: { userId: string; role: string; clinics: string[] },
): Promise<string[] | null> {
  // OWNER：全部
  if (session.role === 'OWNER') return null

  // 店舖帳號：綁定嗰間（UserClinic）
  if (session.role === 'KIOSK') return session.clinics ?? []

  // MANAGER / 有 provider_schedule 權限嘅 EMPLOYEE：主屬店
  const emp = await prisma.employee.findUnique({
    where: { userId: session.userId },
    select: { homeClinicId: true },
  })
  if (emp?.homeClinicId) return [emp.homeClinicId]

  // 冇 employee record → 退回 UserClinic
  if ((session.clinics ?? []).length > 0) return session.clinics

  return []
}

/** 檢查某個 clinicId 喺唔喺範圍內 */
export function inScope(scope: string[] | null, clinicId: string): boolean {
  return scope === null || scope.includes(clinicId)
}
