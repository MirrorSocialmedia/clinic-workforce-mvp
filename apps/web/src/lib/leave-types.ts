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
