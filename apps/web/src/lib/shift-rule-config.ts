// ============================================================
// Shift Rule Config — defaults + merge with clinic overrides
// Stored in Clinic.config JSON field
// ============================================================

export interface ShiftRuleConfig {
  maxDailyHours: number
  maxDailyHoursEnabled: boolean
  maxConsecutiveHours: number
  maxConsecutiveEnabled: boolean
  minRestHours: number
  minRestEnabled: boolean
  longShiftThreshold: number
  longShiftBreakMin: number
  longShiftEnabled: boolean
  overlapCheck: boolean
}

export const DEFAULT_SHIFT_RULE_CONFIG: ShiftRuleConfig = {
  maxDailyHours: 12,
  maxDailyHoursEnabled: true,
  maxConsecutiveHours: 12,
  maxConsecutiveEnabled: true,
  minRestHours: 8,
  minRestEnabled: true,
  longShiftThreshold: 5,
  longShiftBreakMin: 30,
  longShiftEnabled: true,
  overlapCheck: true,
}

/**
 * Merge clinic JSON config with defaults.
 * Clinic.config may be null or partial — always fall back to defaults.
 */
export function parseShiftRuleConfig(raw: string | null | undefined): ShiftRuleConfig {
  if (!raw) return { ...DEFAULT_SHIFT_RULE_CONFIG }
  try {
    const parsed = JSON.parse(raw)
    // Merge: only override fields that exist in parsed
    const config = parsed?.shiftRules || parsed
    if (!config || typeof config !== 'object') return { ...DEFAULT_SHIFT_RULE_CONFIG }
    return {
      maxDailyHours: typeof config.maxDailyHours === 'number' ? config.maxDailyHours : DEFAULT_SHIFT_RULE_CONFIG.maxDailyHours,
      maxDailyHoursEnabled: typeof config.maxDailyHoursEnabled === 'boolean' ? config.maxDailyHoursEnabled : DEFAULT_SHIFT_RULE_CONFIG.maxDailyHoursEnabled,
      maxConsecutiveHours: typeof config.maxConsecutiveHours === 'number' ? config.maxConsecutiveHours : DEFAULT_SHIFT_RULE_CONFIG.maxConsecutiveHours,
      maxConsecutiveEnabled: typeof config.maxConsecutiveEnabled === 'boolean' ? config.maxConsecutiveEnabled : DEFAULT_SHIFT_RULE_CONFIG.maxConsecutiveEnabled,
      minRestHours: typeof config.minRestHours === 'number' ? config.minRestHours : DEFAULT_SHIFT_RULE_CONFIG.minRestHours,
      minRestEnabled: typeof config.minRestEnabled === 'boolean' ? config.minRestEnabled : DEFAULT_SHIFT_RULE_CONFIG.minRestEnabled,
      longShiftThreshold: typeof config.longShiftThreshold === 'number' ? config.longShiftThreshold : DEFAULT_SHIFT_RULE_CONFIG.longShiftThreshold,
      longShiftBreakMin: typeof config.longShiftBreakMin === 'number' ? config.longShiftBreakMin : DEFAULT_SHIFT_RULE_CONFIG.longShiftBreakMin,
      longShiftEnabled: typeof config.longShiftEnabled === 'boolean' ? config.longShiftEnabled : DEFAULT_SHIFT_RULE_CONFIG.longShiftEnabled,
      overlapCheck: typeof config.overlapCheck === 'boolean' ? config.overlapCheck : DEFAULT_SHIFT_RULE_CONFIG.overlapCheck,
    }
  } catch {
    return { ...DEFAULT_SHIFT_RULE_CONFIG }
  }
}
