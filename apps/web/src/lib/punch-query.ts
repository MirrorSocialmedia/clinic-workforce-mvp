/**
 * Punch query helpers — consistent void filtering
 *
 * Use `activeOnly()` for calculations, checks, and counts.
 * Use `allWithVoid()` for audit/display purposes where voided records must be visible.
 */

export function activeOnly() {
  return { void: { is: null as any } } as const
}

export function allWithVoid() {
  return {} as const
}
