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
 * 計糧／總覽嘅診所範圍。
 *
 * @returns null = 唔限制（OWNER）；string[] = 只限呢啲診所
 */
export async function resolveClinicScope(
  session: { userId: string; role: string; clinics: string[] },
  perms: string[],
): Promise<string[] | null> {
  // ROLE-OK: OWNER 全公司，刻意用 role
  if (session.role === 'OWNER') return null

  // ★ MANAGER：自己被指派嘅診所（同現行 scope='my-clinics' 一致）
  if (session.role === 'MANAGER') return session.clinics

  // ★ EMPLOYEE 靠權限放行 → 只限主屬診所（2026-08-03 決定）
  if (perms.includes('payroll_generate') || perms.includes('employee_overview')) {
    const home = await getOwnHomeClinicId(session.userId)
    return home ? [home] : [] // ★ 冇主屬店 = 乜都睇唔到（fail-closed）
  }

  return []
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
  // ROLE-OK: 保密員工隔離
  if (session.role === 'OWNER') return true
  // ROLE-OK: MANAGER 唔會因為主屬診所而放寬（2026-08-03 決定）
  if (session.role === 'MANAGER') return false

  if (!perms.includes('payroll_generate') && !perms.includes('employee_overview')) return false

  const home = await getOwnHomeClinicId(session.userId)
  // ★ 兩邊都要有主屬店先算「同店」—— null 唔應該當成 match
  return !!home && !!targetEmployee.homeClinicId && home === targetEmployee.homeClinicId
}
