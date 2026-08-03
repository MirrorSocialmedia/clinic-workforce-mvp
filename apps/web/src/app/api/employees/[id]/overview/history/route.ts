export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope, canSeeConfidential } from '@/lib/scope-helpers'
import { toHKDateStr, getMonthRange, periodMonthKey } from '@/lib/hk-date'

// ★ 呢條 route 只可以呼叫 lib/ 嘅共用函數，唔可以自己由原始表格砌計算。

// GET /api/employees/[id]/overview/history?months=12 — History data (slow)
// Returns: ⑤ 考勤摘要 ⑥ 計糧記錄 ⑦ 假期記錄 ⑧ 工資歷史
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const emp = await prisma.employee.findUnique({
    where: { id: params.id },
    select: { payConfidential: true, homeClinicId: true },
  })

  if (!emp) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  // ★ Scope check: EMPLOYEE with employee_overview can only see same home-clinic employees
  const allowed = await resolveClinicScope(session, auth.perms ?? [])
  if (allowed !== null && emp.homeClinicId && !allowed.includes(emp.homeClinicId)) {
    return NextResponse.json({ error: '只可以查看主屬診所嘅員工' }, { status: 403 })
  }

  // ★ Confidential check via unified helper (2026-08-03)
  if (!(await canSeeConfidential(session, auth.perms ?? [], emp))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const months = parseInt(url.searchParams.get('months') || '12', 10)

  // Calculate date range
  const now = new Date()
  const startMonth = new Date(now.getFullYear(), now.getMonth() - months + 1, 1)
  const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0)

  // 1) Payroll items (計糧記錄)
  const payrollRuns = await prisma.payrollRun.findMany({
    where: {
      periodMonth: { gte: startMonth, lte: endMonth },
    },
    select: { id: true, periodMonth: true },
    orderBy: { periodMonth: 'desc' },
  })

  const payrollItems = await prisma.payrollItem.findMany({
    where: {
      employeeId: params.id,
      runId: { in: payrollRuns.map(r => r.id) },
    },
    include: {
      run: { select: { periodMonth: true } },
    },
  })

  const payrollHistory = payrollItems.map(item => {
    const detail = item.detailJson ? JSON.parse(item.detailJson) : {}
    return {
      periodMonth: periodMonthKey(item.run.periodMonth),
      basePay: item.basePay,
      otPay: item.otPay,
      splitPay: item.splitPay,
      deduction: item.deduction,
      sickDeduction: detail.sickDeduction ?? 0,
      totalPayable: item.totalPayable,
      grossPay: detail.grossPay ?? null,
      mpfEmployee: detail.mpfEmployee ?? null,
      mpfEmployer: detail.mpfEmployer ?? null,
      workedHours: item.workedHours,
      otHours: item.otHours,
      leaveDays: item.leaveDays,
      absentDays: item.absentDays,
    }
  })

  // 2) Leave records (假期記錄)
  const leaveRecords = await prisma.leaveRequest.findMany({
    where: {
      employeeId: params.id,
      status: { in: ['APPROVED', 'CANCELLED', 'REJECTED'] },
      OR: [
        { startDate: { gte: startMonth, lte: endMonth } },
        { endDate: { gte: startMonth, lte: endMonth } },
      ],
    },
    include: {
      leaveType: { select: { name: true, systemKey: true, isPaid: true } },
    },
    orderBy: { startDate: 'desc' },
  })

  // 3) Attendance summary from payroll items (考勤摘要)
  const attendanceSummary = payrollItems.map(item => ({
    periodMonth: periodMonthKey(item.run.periodMonth),
    workedHours: item.workedHours,
    otHours: item.otHours,
    leaveDays: item.leaveDays,
    absentDays: item.absentDays,
    sickDays: (() => {
      try {
        const detail = JSON.parse(item.detailJson || '{}')
        return detail.sickLeaveDays ?? 0
      } catch { return 0 }
    })(),
  }))

  // 4) Wage history (工資歷史)
  const wageHistory = await prisma.wageHistory.findMany({
    where: {
      employeeId: params.id,
      periodMonth: { gte: toHKDateStr(startMonth).slice(0, 7), lte: toHKDateStr(endMonth).slice(0, 7) },
    },
    orderBy: { periodMonth: 'desc' },
  })

  return NextResponse.json({
    payroll: payrollHistory,
    attendance: attendanceSummary,
    leaves: leaveRecords.map((l: any) => ({
      id: l.id,
      leaveType: l.leaveType.name,
      systemKey: l.leaveType.systemKey,
      isPaid: l.leaveType.isPaid,
      startDate: l.startDate.toISOString().slice(0, 10),
      endDate: l.endDate.toISOString().slice(0, 10),
      days: l.days,
      status: l.status,
    })),
    wageHistory: wageHistory.map(w => ({
      periodMonth: w.periodMonth,
      totalWage: w.totalWage,
      excludedDays: w.excludedDays,
      excludedWage: w.excludedWage,
      calendarDays: w.calendarDays,
    })),
  }, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  })
}
