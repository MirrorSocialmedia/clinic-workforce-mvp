import { prisma } from './prisma'

/**
 * 攞當前使用者嘅主屬診所 ID。
 *
 * ★ 唔放入 JWT —— session.clinics 之前就係因為 JWT 快照過期
 * （改咗指派要等 365 日 token 過期）而改成由 DB 讀。
 * 主屬診所同樣會變，唔可以快照。
 */
export async function getOwnHomeClinicId(userId: string): Promise<string | null> {
  const emp = await prisma.employee.findUnique({
    where: { userId },
    select: { homeClinicId: true },
  })
  return emp?.homeClinicId ?? null
}

/**
 * 診所範圍。
 *
 * @param forPerms 只考慮呢啲權限 —— 因為唔同用途對同一個員工要求唔同範圍：
 * · 計糧生成 / 員工總覽 → 主屬店（涉及薪金）
 * · 考勤 / 排班 → 全公司（調鋪要跨店）
 */
export async function resolveClinicScope(
  session: { userId: string; role: string; clinics: string[] },
  perms: string[],
  forPerms: {
    /** 呢啲權限 → 全公司 */ companyWide?: string[]
    /** 呢啲權限 → 主屬店 */ homeOnly?: string[]
  },
): Promise<string[] | null> {
  // ★ 同時填兩組 = 設計問題 —— 同一個人可能兩組權限都有，
  // companyWide 會靜靜蓋過 homeOnly（2026-08-03 撞到）。
  if ((forPerms.companyWide?.length ?? 0) > 0 && (forPerms.homeOnly?.length ?? 0) > 0) {
    console.warn(
      '[resolveClinicScope] ⚠️ companyWide + homeOnly both set on same call — ' +
      'companyWide takes priority. Use separate calls or query params to split.',
    )
  }

  // ROLE-OK: OWNER 全公司，刻意用 role
  if (session.role === 'OWNER') return null

  // ROLE-OK: 2026-08-03 決定 MANAGER 見全公司（保密由 getConfidentialScope 擋）
  if (session.role === 'MANAGER') return null

  // ★ companyWide：有其中一個權限 → 全公司（考勤、排班需要跨店）
  if ((forPerms.companyWide ?? []).some(p => perms.includes(p))) return null

  // ★ homeOnly：有其中一個權限 → 只限主屬店（計糧、總覽涉及薪金）
  if ((forPerms.homeOnly ?? []).some(p => perms.includes(p))) {
    const home = await getOwnHomeClinicId(session.userId)
    return home ? [home] : [] // ★ 冇主屬店 = 乜都睇唔到（fail-closed）
  }

  return []
}

/**
 * 公司範圍 —— 用戶管嘅 companyId 集合。
 *
 * ★ 2026-08-21: SchedulingMemo 係公司級備註（拍板：MANAGER 唔可以寫其他公司）。
 *   現有 resolveClinicScope 回嘅係【診所】ID，唔可以直接用於公司級寫入檢查，
 *   所以另設呢個 company 級 helper：
 * · OWNER → null（全部公司）
 * · 其他角色 → 佢被指派診所（UserClinic）所屬 companyId 嘅並集；
 *   冇任何診所 / 診所冇關公司 → 空集（fail-closed）。
 */
export async function resolveAccessibleCompanyIds(
  userId: string,
  role: string,
): Promise<string[] | null> {
  // ROLE-OK: OWNER 全公司，刻意用 role
  if (role === 'OWNER') return null
  const links = await prisma.userClinic.findMany({
    where: { userId },
    include: { clinic: { select: { companyId: true } } },
  })
  return [...new Set(links.map(l => l.clinic.companyId).filter((c): c is string => !!c))]
}

/**
 * 某個公司喺唔喺用戶嘅公司範圍內。
 * @param companyIds resolveAccessibleCompanyIds 嘅回傳值（null = OWNER 全部公司）
 */
export function companyInScope(companyIds: string[] | null, companyId: string): boolean {
  if (companyIds === null) return true
  return companyIds.includes(companyId)
}

/**
 * 排班相關公司級寫入嘅公司範圍（pl-mark / scheduling-memo 共用）。
 *
 * ★ = resolveAccessibleCompanyIds + MANAGER fallback：
 *   resolveAccessibleCompanyIds 只睇 UserClinic，而 MANAGER 可能只係有
 *   Employee.homeClinicId（無 UserClinic row）→ 空陣列 → companyInScope
 *   永遠 false → 連自己公司都 403（症狀似「權限設定錯」，好難聯想到
 *   UserClinic 缺失 —— 2026-08-21 拍板要加 fallback）。
 *   有 UserClinic 嘅人 fallback 唔會觸發（length>0），無害。
 *
 * @returns null = 全部公司（OWNER）；string[] = 可寫公司（[] = fail-closed）
 */
export async function resolveCompanyScopeForScheduling(
  userId: string,
  role: string,
): Promise<string[] | null> {
  const companyIds = await resolveAccessibleCompanyIds(userId, role)
  // ★ 必須 check !== null —— OWNER 回 null（全部公司），唔可以行 fallback
  if (companyIds !== null && companyIds.length === 0) {
    const homeClinicId = await getOwnHomeClinicId(userId)
    if (homeClinicId) {
      const c = await prisma.clinic.findUnique({
        where: { id: homeClinicId },
        select: { companyId: true },
      })
      if (c?.companyId) return [c.companyId]
    }
  }
  return companyIds
}

/**
 * 保密員工可見範圍（畀列表過濾用，避免逐個 await）。
 *
 * @returns null = 全部可見（OWNER）；string[] = 只可見呢啲診所嘅保密員工
 */
export async function getConfidentialScope(
  session: { userId: string; role: string },
  perms: string[],
): Promise<string[] | null> {
  // ROLE-OK: OWNER 全公司，刻意用 role
  if (session.role === 'OWNER') return null
  // ROLE-OK: 2026-08-03 決定 MANAGER 一律唔見保密員工，唔放寬
  if (session.role === 'MANAGER') return []
  if (!perms.includes('payroll_generate') && !perms.includes('employee_overview')) return []
  const home = await getOwnHomeClinicId(session.userId)
  return home ? [home] : []
}

/**
 * 可唔可以睇某員工嘅保密薪金。
 *
 * ★ 2026-08-03 決定：
 * · OWNER —— 全部可以
 * · EMPLOYEE + payroll_generate/employee_overview —— 【同主屬診所】可以
 * · MANAGER —— 一律唔可以（維持現狀，冇按診所放寬）
 */
export async function canSeeConfidential(
  session: { userId: string; role: string },
  perms: string[],
  targetEmployee: { payConfidential: boolean; homeClinicId: string | null },
): Promise<boolean> {
  if (!targetEmployee.payConfidential) return true
  const scope = await getConfidentialScope(session, perms)
  if (scope === null) return true
  return !!targetEmployee.homeClinicId && scope.includes(targetEmployee.homeClinicId)
}
