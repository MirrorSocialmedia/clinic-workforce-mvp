// Permission keys and role defaults
export const PERMISSIONS = {
  scheduling: '排班管理',
  attendance_manage: '考勤管理（補登/修正/作廢）',
  payroll_view: '計糧查看',
  payroll_generate: '計糧生成',
  pay_rules: '薪酬規則',
  pay_view_confidential: '查看保密薪資',
  leave_approve: '假期審批',
  timebank_ops: '時間帳戶操作（換假/還鐘）',
  accounts_manage: '帳號管理',
  clinic_manage: '診所/公司管理',
  audit_view: '審計日誌',
} as const

export type PermKey = keyof typeof PERMISSIONS

export const ROLE_DEFAULTS: Record<string, PermKey[]> = {
  OWNER: Object.keys(PERMISSIONS) as PermKey[],
  MANAGER: ['scheduling', 'attendance_manage', 'payroll_view', 'payroll_generate', 'leave_approve', 'timebank_ops'],
  ACCOUNTANT: ['payroll_view'],
  EMPLOYEE: [],
}

/**
 * Resolve the effective permission set for a user.
 * ROLE_DEFAULTS[role] ∪ grant − deny
 */
export function resolvePermissions(role: string, grant: string[] = [], deny: string[] = []): string[] {
  const base = ROLE_DEFAULTS[role] || []
  const g = new Set([...base, ...grant])
  const d = new Set(deny)
  return Array.from(g).filter(k => !d.has(k))
}

/**
 * Check if a user has a specific permission.
 */
export function hasPermission(role: string, perm: PermKey, grant: string[] = [], deny: string[] = []): boolean {
  if (deny.includes(perm)) return false
  const base = ROLE_DEFAULTS[role] || []
  return base.includes(perm) || grant.includes(perm)
}
