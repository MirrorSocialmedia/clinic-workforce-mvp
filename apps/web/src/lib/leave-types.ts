/**
 * Leave type system keys — single source of truth.
 * Any typos (e.g. ANNUAL vs ANNUAL_LEAVE) will be caught at compile time.
 */
export const LEAVE_SYSTEM_KEYS = {
  REST_DAY: 'REST_DAY',
  ANNUAL: 'ANNUAL_LEAVE',
  OT: 'OT_LEAVE',
  SICK: 'SICK',
} as const

/** Leave types that deduct from LeaveBalance quota — SICK / unpaid are excluded. */
export const QUOTA_LEAVE_KEYS = [
  LEAVE_SYSTEM_KEYS.REST_DAY,
  LEAVE_SYSTEM_KEYS.ANNUAL,
  LEAVE_SYSTEM_KEYS.OT,
] as const

/** 可以預支（餘額可負）嘅假期類型 —— 下個月還 */
export const NEGATIVE_ALLOWED_KEYS = [LEAVE_SYSTEM_KEYS.REST_DAY] as const

export function allowsNegativeBalance(systemKey: string | null): boolean {
  return NEGATIVE_ALLOWED_KEYS.includes(systemKey as any)
}
