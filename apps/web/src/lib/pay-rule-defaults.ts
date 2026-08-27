import type { PayRuleConfigModular } from '@/lib/payroll-engine'

export const DEFAULT_MODIFIERS = {
  attendance_bonus: {
    amount: 500,
    cancel_if: {
      // [cwm-bonusrules-20260827] 三條獨立規則（預設 15/5/30），任何一條命中即取消（>= 門檻）
      late_single_exceed: 15,
      late_count_exceed: 5,
      late_total_exceed: 30,
      any_unplanned_leave: true,
      any_absence: true,
    },
  },
  overtime: {
    mode: 'time_off',
    multiplier: 1.5,
    threshold: 9,
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

/** 生日假 modifier 嘅預設值（用家撳「啟用」時填入） */
export const BIRTHDAY_LEAVE_DEFAULT = {
  days_per_year: 1,
} as const

/** 年假階梯 modifier 嘅預設值（用家撳「啟用」時填入） */
export const ANNUAL_LEAVE_DEFAULT = {
  table: [] as number[],
} as const

export function buildDefaultPayConfig(payType: string, baseAmount?: number | null): any {
  const isMonthly = payType === 'MONTHLY'
  const modifiers: any = {
    ...DEFAULT_MODIFIERS,
    deduction: { basis: 'statutory' },
    mpf: { enabled: true, rate: 0.05, min: 7100, max: 30000 },
    working_days: { basis: 'scheduled', ...DEFAULT_MODIFIERS.working_days },
  }
  if (!isMonthly) {
    delete modifiers.attendance_bonus // 時薪冇獎金冇 OT
    delete modifiers.overtime
  }
  return {
    base_type: isMonthly ? 'monthly' : 'hourly',
    ...(isMonthly ? { monthly_salary: baseAmount ?? 0 } : { hourly_rate: baseAmount ?? 0 }),
    modifiers,
  }
}

