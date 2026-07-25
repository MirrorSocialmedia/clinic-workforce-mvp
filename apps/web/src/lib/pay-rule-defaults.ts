import type { PayRuleConfigModular } from '@/lib/payroll-engine'

export const DEFAULT_MODIFIERS = {
  attendance_bonus: {
    amount: 500,
    cancel_if: {
      late_minutes_exceed: 30,
      late_is_cumulative: true,
      any_unplanned_leave: true,
      any_absence: true,
    },
  },
  overtime: {
    mode: 'time_off',
    multiplier: 1.5,
    threshold: 8,
    ot_min_minutes: 0,
    ot_round_minutes: 0,
  },
  late_policy: {
    deduct_salary: false,
    affects_bonus: true,
    offset_from_time_bank: true,
  },
  time_bank: {
    negative_carry: 'next_month',
  },
  working_days: {
    rest_days: [6, 0],
    count_public_holidays: true,
  },
  lunch_break: {
    enabled: false,
    defaultMinutes: 60,
    minMinutes: 30,
  },
} satisfies NonNullable<PayRuleConfigModular['modifiers']>

export function buildDefaultPayConfig(payType: string, baseAmount?: number | null): any {
  const isMonthly = payType === 'MONTHLY'
  return {
    base_type: isMonthly ? 'monthly' : 'hourly',
    ...(isMonthly ? { monthly_salary: baseAmount ?? 0 } : { hourly_rate: baseAmount ?? 0 }),
    modifiers: {
      ...DEFAULT_MODIFIERS,
      ...(isMonthly ? {} : { attendance_bonus: undefined, overtime: undefined }),
      deduction: { basis: 'statutory' },
      mpf: { enabled: true, rate: 0.05, min: 7100, max: 30000 },
      working_days: { basis: 'scheduled', ...DEFAULT_MODIFIERS.working_days },
    },
  }
}
