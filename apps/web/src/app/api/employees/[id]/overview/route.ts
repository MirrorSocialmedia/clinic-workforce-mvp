// ownership-ok: assertClinicAccess + RBAC matrix 控制
export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope, canSeeConfidential } from '@/lib/scope-helpers'
import { calculateADW, getEffectiveADW } from '@/lib/adw'
import { getTimeAccountSummary } from '@/lib/timebank-summary'
import { deductionDailyRate } from '@/lib/payroll-engine'

// ★ 呢條 route 只可以呼叫 lib/ 嘅共用函數，唔可以自己由原始表格砌計算。
//   時間帳戶用 getTimeAccountSummary、ADW 用 calculateADW、
//   扣薪日率用 deductionDailyRate —— 任何一個自己再算都會同計糧單分歧。

// GET /api/employees/[id]/overview — Basic info (fast, instant)
// Returns: ① 基本資料 ② 薪酬設定 ③ 假期結餘
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  // Fetch employee with all needed basic data
  const emp = await prisma.employee.findUnique({
    where: { id: params.id },
    include: {
      user: { select: { id: true, name: true, phone: true, email: true, role: true, createdAt: true, fullName: true } },
      clinics: { include: { clinic: { select: { id: true, name: true, shortName: true } } } },
      homeClinic: { select: { id: true, name: true, shortName: true } },
      payRules: {
        where: { isActive: true },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 1,
      },
      leaveBalances: {
        include: {
          leaveType: { select: { id: true, name: true, systemKey: true, isPaid: true } },
        },
      },
    },
  })

  if (!emp) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  // ★ Scope check: EMPLOYEE with employee_overview can only see same home-clinic employees
  // forPerms: 員工總覽 → homeOnly（只限主屬診所）
  const allowed = await resolveClinicScope(session, auth.perms ?? [], {
    homeOnly: ['employee_overview'],
  })
  if (allowed !== null && emp.homeClinicId && !allowed.includes(emp.homeClinicId)) {
    return NextResponse.json({ error: '只可以查看主屬診所嘅員工' }, { status: 403 })
  }

  // ★ Confidential check via unified helper (2026-08-03)
  if (!(await canSeeConfidential(session, auth.perms ?? [], emp))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const activeRule = emp.payRules[0] || null
  let config: any = {}
  if (activeRule?.configJson) {
    try { config = JSON.parse(activeRule.configJson) } catch {}
  }

  // Calculate ADW and deduction daily rate (server-side)
  const now = new Date()
  const adwResult = await calculateADW(prisma, emp.id, now)
  const monthlySalary = config.monthly_salary ?? emp.payRules[0]?.baseAmount ?? 0
  const effectiveADW = await getEffectiveADW(prisma, emp.id, now, monthlySalary, config.adw_policy ?? 'ADW')

  // Deduction daily rate
  const deductionRate = deductionDailyRate(
    monthlySalary,
    new Date(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`),
    config.deduction_basis ?? 'workday',
    undefined,
  )

  // Time account (included in basic since it's needed for overview)
  const timeAccountRows = await getTimeAccountSummary(prisma, [
    {
      id: emp.id,
      user: { name: emp.user.name },
      payRules: emp.payRules,
    },
  ])
  const timeAccount = timeAccountRows[0]

  // ★ 換假換算：comp_leave_day_minutes → ot_threshold_daily×60 → 540（公司固定 9 小時）
  const dayMin = config.comp_leave_day_minutes
    ?? (config.ot_threshold_daily ? config.ot_threshold_daily * 60 : null)
    ?? 540
  const compLeaveDays = timeAccount?.timeAccountMinutes != null && timeAccount.timeAccountMinutes > 0
    ? +(timeAccount.timeAccountMinutes / dayMin).toFixed(2)
    : null

  return NextResponse.json({
    basic: {
      id: emp.id,
      name: emp.user.name,
      fullName: emp.user.fullName,
      phone: emp.user.phone,
      email: emp.user.email,
      role: emp.user.role,
      status: emp.status,
      joinDate: emp.joinDate.toISOString().split('T')[0],
      resignedAt: emp.resignedAt?.toISOString().split('T')[0] || null,
      payConfidential: emp.payConfidential,
      homeClinic: emp.homeClinic ? { id: emp.homeClinic.id, name: emp.homeClinic.name, shortName: emp.homeClinic.shortName } : null,
      clinics: emp.clinics.map(c => ({
        id: c.clinic.id,
        name: c.clinic.name,
        shortName: c.clinic.shortName,
        isPrimary: c.isPrimary,
      })),
    },
    payRules: activeRule ? {
      payType: activeRule.payType,
      baseAmount: activeRule.baseAmount,
      configJson: config,
      effectiveFrom: activeRule.effectiveFrom.toISOString().split('T')[0],
      monthlySalary: config.monthly_salary ?? null,
      hourlyRate: config.hourly_rate ?? null,
      dailyRate: config.daily_rate ?? null,
      splitRatio: config.split_ratio ?? null,
      splitBaseGuarantee: config.base_guarantee ?? null,
      otThreshold: config.ot_threshold ?? null,
      lunchBreakMinutes: config.lunch_break_minutes ?? null,
      attendanceBonus: config.attendance_bonus ?? null,
      attendanceBonusCancelLateMin: config.attendance_bonus_cancel_late_min ?? null,
    } : null,
    leaveBalances: emp.leaveBalances.map(b => ({
      id: b.id,
      leaveTypeId: b.leaveTypeId,
      leaveTypeName: b.leaveType.name,
      systemKey: b.leaveType.systemKey,
      year: b.year,
      entitled: b.entitled,
      used: b.used,
      remaining: b.remaining,
      isPaid: b.leaveType.isPaid,
    })),
    timeAccount: timeAccount ? {
      minutes: timeAccount.timeAccountMinutes,
      status: timeAccount.status,
      compLeaveDayMinutes: dayMin,
      compLeaveDays,
    } : null,
    adw: {
      adw: adwResult.adw,
      totalWage: adwResult.totalWage,
      totalDays: adwResult.totalDays,
      isShortPeriod: adwResult.isShortPeriod,
      warnings: adwResult.warnings,
    },
    effectiveADW,
    deductionDailyRate: deductionRate,
  }, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  })
}
