// ============================================================
// Shift Validator Engine
// Reads rules from docs/rules/shift-rules.json — nothing hardcoded
// ============================================================

import shiftRules from './shift-rules.json'

// Types
interface ShiftInput {
  id?: string
  employeeId: string
  clinicId: string
  date: string // ISO date string (YYYY-MM-DD)
  startTime: string // ISO datetime
  endTime: string // ISO datetime
  role?: string // Doctor, Nurse, Receptionist
  status?: string
}

interface ValidationIssue {
  type: 'error' | 'warning'
  rule: string
  message: string
  shiftId?: string
  employeeId?: string
  clinicId?: string
}

interface ValidationResult {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

// Helper: parse time string "HH:MM" to minutes since midnight
function parseTimeMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number)
  return h * 60 + m
}

// Helper: get shift duration in hours
function getShiftHours(start: string, end: string): number {
  const s = new Date(start)
  const e = new Date(end)
  return (e.getTime() - s.getTime()) / (1000 * 60 * 60)
}

// Helper: check if two time ranges overlap
function timeRangesOverlap(
  s1: string, e1: string, s2: string, e2: string,
  allowOverlapMinutes: number = 0
): boolean {
  const start1 = new Date(s1).getTime()
  const end1 = new Date(e1).getTime()
  const start2 = new Date(s2).getTime()
  const end2 = new Date(e2).getTime()
  const overlapMs = allowOverlapMinutes * 60 * 1000

  // Overlap if one starts before the other ends, minus allowed overlap
  return start1 < (end2 - overlapMs) && end1 > (start2 + overlapMs)
}

// Helper: get minutes between two times
function getMinutesBetween(a: string, b: string): number {
  const d1 = new Date(a)
  const d2 = new Date(b)
  return Math.abs((d2.getTime() - d1.getTime()) / (1000 * 60))
}

// Helper: get rest hours between two shifts
function getRestHoursBetween(
  end1: string, start2: string
): number {
  const e1 = new Date(end1).getTime()
  const s2 = new Date(start2).getTime()
  const diff = s2 - e1
  if (diff < 0) return 0 // second shift starts before first ends
  return diff / (1000 * 60 * 60)
}

// Helper: get clinic-specific rule overrides
function getClinicOverrides(clinicId: string) {
  const overrides = shiftRules.clinic_specific_overrides?.overrides || []
  return overrides.find((o: any) => o.clinic_id === clinicId)
}

// Helper: get effective rule value (with clinic overrides)
function getEffectiveRule(key: string, clinicId: string, defaultVal: any): any {
  const override = (getClinicOverrides(clinicId)?.override as Record<string, any>) || null
  if (override && override[key] !== undefined) {
    return override[key]
  }
  return defaultVal
}

// ============================================================
// Core Validation Functions
// ============================================================

/**
 * Check for shift collisions (same employee, overlapping times)
 */
function checkCollisions(
  newShift: ShiftInput,
  existingShifts: ShiftInput[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const rules = shiftRules.conflict_rules

  if (!rules?.collision_check) return issues

  const allowOverlap = rules.allow_overlap_minutes || 0

  for (const existing of existingShifts) {
    if (existing.employeeId !== newShift.employeeId) continue
    if (existing.id === newShift.id) continue // skip self

    if (timeRangesOverlap(
      newShift.startTime, newShift.endTime,
      existing.startTime, existing.endTime,
      allowOverlap
    )) {
      issues.push({
        type: 'error',
        rule: 'collision_check',
        message: `撞更: ${newShift.employeeId} 在 ${newShift.date} 有重疊班次 (${formatTime(newShift.startTime)}-${formatTime(newShift.endTime)} 與 ${formatTime(existing.startTime)}-${formatTime(existing.endTime)})`,
        shiftId: newShift.id,
        employeeId: newShift.employeeId,
        clinicId: newShift.clinicId,
      })
    }
  }

  return issues
}

/**
 * Check minimum staff requirements per shift
 */
function checkMinStaff(
  shifts: ShiftInput[],
  clinicId: string,
  date: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const minStaffRules = shiftRules.min_staff_per_shift

  if (!minStaffRules?.rules?.length) return issues

  // Get shifts for the given clinic and date
  const clinicDateShifts = shifts.filter(
    s => s.clinicId === clinicId && s.date === date
  )

  // Check each rule
  for (const rule of minStaffRules.rules) {
    // Skip if rule is for a specific clinic that doesn't match
    if (rule.clinic_id !== '*' && rule.clinic_id !== clinicId) continue

    const [timeStart, timeEnd] = rule.shift_time.split('-')
    const ruleStartMin = parseTimeMinutes(timeStart)
    const ruleEndMin = parseTimeMinutes(timeEnd)

    // Find shifts that overlap with this time range
    const overlappingShifts = clinicDateShifts.filter(s => {
      const shiftStartMin = parseTimeMinutes(formatTime(s.startTime).slice(0, 5))
      const shiftEndMin = parseTimeMinutes(formatTime(s.endTime).slice(0, 5))
      return shiftStartMin < ruleEndMin && shiftEndMin > ruleStartMin
    })

    // Count roles
    for (const [role, required] of Object.entries(rule.required)) {
      const count = overlappingShifts.filter(
        s => s.role?.toLowerCase() === role.toLowerCase()
      ).length

      if (count < required) {
        issues.push({
          type: 'warning',
          rule: 'min_staff_per_shift',
          message: `缺人警示: ${clinicId} 在 ${date} ${rule.shift_time} 需要 ${required} 名 ${role}，目前只有 ${count} 名`,
          clinicId,
        })
      }
    }
  }

  return issues
}

/**
 * Check consecutive working hours
 */
function checkConsecutiveHours(
  newShift: ShiftInput,
  existingShifts: ShiftInput[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const maxConsecutive = getEffectiveRule(
    'max_consecutive_hours',
    newShift.clinicId,
    shiftRules.working_hour_rules?.max_consecutive_hours || 12
  )

  // Get all shifts for this employee in the same date range (±2 days)
  const date = new Date(newShift.date)
  const twoDaysBefore = new Date(date)
  twoDaysBefore.setDate(date.getDate() - 2)
  const twoDaysAfter = new Date(date)
  twoDaysAfter.setDate(date.getDate() + 2)

  const employeeShifts = existingShifts
    .filter(s => s.employeeId === newShift.employeeId)
    .filter(s => {
      const d = new Date(s.date)
      return d >= twoDaysBefore && d <= twoDaysAfter
    })
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

  // Check if adding this shift creates a consecutive block exceeding the limit
  const allShifts = [...employeeShifts, newShift].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  )

  // Walk through consecutive shifts
  for (let i = 0; i < allShifts.length - 1; i++) {
    const current = allShifts[i]
    const next = allShifts[i + 1]

    // Check if they're consecutive (less than min_rest_between_shifts apart)
    const restHours = getRestHoursBetween(current.endTime, next.startTime)
    const minRest = getEffectiveRule(
      'min_rest_between_shifts',
      current.clinicId,
      shiftRules.working_hour_rules?.min_rest_between_shifts || 8
    )

    if (restHours < minRest && restHours >= 0) {
      // These are consecutive — check total duration
      const totalHours = getShiftHours(current.startTime, current.endTime) +
        getShiftHours(next.startTime, next.endTime) + restHours

      if (totalHours > maxConsecutive) {
        issues.push({
          type: 'warning',
          rule: 'max_consecutive_hours',
          message: `連續工時超標: ${current.employeeId} 連續工時 ${totalHours.toFixed(1)} 小時，超過上限 ${maxConsecutive} 小時`,
          employeeId: current.employeeId,
          shiftId: current.id,
        })
      }
    }
  }

  return issues
}

/**
 * Check minimum rest between shifts
 */
function checkRestBetweenShifts(
  newShift: ShiftInput,
  existingShifts: ShiftInput[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const minRest = getEffectiveRule(
    'min_rest_between_shifts',
    newShift.clinicId,
    shiftRules.working_hour_rules?.min_rest_between_shifts || 8
  )

  // Get adjacent shifts for this employee
  const employeeShifts = existingShifts
    .filter(s => s.employeeId === newShift.employeeId)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

  for (const existing of employeeShifts) {
    if (existing.id === newShift.id) continue

    // Check rest after existing shift before new shift
    const restAfterExisting = getRestHoursBetween(existing.endTime, newShift.startTime)
    if (restAfterExisting >= 0 && restAfterExisting < minRest) {
      issues.push({
        type: 'warning',
        rule: 'min_rest_between_shifts',
        message: `休息不足: ${newShift.employeeId} 兩班之間僅休息 ${restAfterExisting.toFixed(1)} 小時，最低要求 ${minRest} 小時`,
        employeeId: newShift.employeeId,
        shiftId: newShift.id,
      })
      break // Only report once
    }

    // Check rest after new shift before existing shift
    const restAfterNew = getRestHoursBetween(newShift.endTime, existing.startTime)
    if (restAfterNew >= 0 && restAfterNew < minRest) {
      issues.push({
        type: 'warning',
        rule: 'min_rest_between_shifts',
        message: `休息不足: ${newShift.employeeId} 兩班之間僅休息 ${restAfterNew.toFixed(1)} 小時，最低要求 ${minRest} 小時`,
        employeeId: newShift.employeeId,
        shiftId: newShift.id,
      })
      break
    }
  }

  return issues
}

/**
 * Check max daily hours
 */
function checkMaxDailyHours(
  newShift: ShiftInput,
  existingShifts: ShiftInput[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const maxDaily = shiftRules.working_hour_rules?.max_daily_hours || 12

  // Get all shifts for this employee on this date
  const dailyShifts = existingShifts
    .filter(s => s.employeeId === newShift.employeeId && s.date === newShift.date)

  let totalHours = 0
  for (const s of dailyShifts) {
    totalHours += getShiftHours(s.startTime, s.endTime)
  }
  totalHours += getShiftHours(newShift.startTime, newShift.endTime)

  if (totalHours > maxDaily) {
    issues.push({
      type: 'error',
      rule: 'max_daily_hours',
      message: `單日工時超標: ${newShift.employeeId} 在 ${newShift.date} 總工時 ${totalHours.toFixed(1)} 小時，超過上限 ${maxDaily} 小時`,
      employeeId: newShift.employeeId,
    })
  }

  return issues
}

/**
 * Check mandatory breaks
 */
function checkMandatoryBreaks(newShift: ShiftInput): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const breakRules = shiftRules.break_rules
  if (!breakRules) return issues

  const shiftHours = getShiftHours(newShift.startTime, newShift.endTime)

  if (shiftHours >= breakRules.mandatory_break_after_hours) {
    // For MVP we just warn — actual break tracking requires punch records
    issues.push({
      type: 'warning',
      rule: 'mandatory_break',
      message: `休息提醒: 班次工時 ${shiftHours.toFixed(1)} 小時，超過 ${breakRules.mandatory_break_after_hours} 小時需安排 ${breakRules.minimum_break_minutes} 分鐘休息`,
      shiftId: newShift.id,
    })
  }

  return issues
}

// ============================================================
// Main Validation Function
// ============================================================

/**
 * Validate a new/edit shift against all rules
 */
export async function validateShift(
  newShift: ShiftInput,
  existingShifts: ShiftInput[]
): Promise<ValidationResult> {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  // Run all checks
  const collisionIssues = checkCollisions(newShift, existingShifts)
  const dailyHoursIssues = checkMaxDailyHours(newShift, existingShifts)
  const consecutiveIssues = checkConsecutiveHours(newShift, existingShifts)
  const restIssues = checkRestBetweenShifts(newShift, existingShifts)
  const breakIssues = checkMandatoryBreaks(newShift)

  for (const issue of [
    ...collisionIssues,
    ...dailyHoursIssues,
    ...consecutiveIssues,
    ...restIssues,
    ...breakIssues,
  ]) {
    if (issue.type === 'error') {
      errors.push(issue)
    } else {
      warnings.push(issue)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Validate min staff for a clinic on a specific date
 */
export async function validateClinicStaff(
  allShifts: ShiftInput[],
  clinicId: string,
  date: string
): Promise<ValidationResult> {
  const warnings = checkMinStaff(allShifts, clinicId, date)

  return {
    valid: true, // staff warnings are non-blocking
    errors: [],
    warnings,
  }
}

/**
 * Validate a batch of shifts (e.g., after bulk template application)
 */
export async function validateShiftBatch(
  newShifts: ShiftInput[],
  existingShifts: ShiftInput[]
): Promise<ValidationResult> {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  const allShifts = [...existingShifts, ...newShifts]

  for (const shift of newShifts) {
    const result = await validateShift(shift, allShifts)
    errors.push(...result.errors)
    warnings.push(...result.warnings)
  }

  // Also check min staff for affected clinics/dates
  const affectedClinics = new Set(newShifts.map(s => s.clinicId))
  const affectedDates = new Set(newShifts.map(s => s.date))

  for (const clinicId of affectedClinics) {
    for (const date of affectedDates) {
      const staffResult = await validateClinicStaff(allShifts, clinicId, date)
      warnings.push(...staffResult.warnings)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

// ============================================================
// Helpers
// ============================================================

function formatTime(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// Export rules for reference in UI
export const getShiftRules = () => shiftRules
export type { ValidationResult, ValidationIssue, ShiftInput }
