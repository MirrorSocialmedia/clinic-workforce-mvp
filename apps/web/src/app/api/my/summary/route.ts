export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr, hkDateStart, hkDateEnd, getMonthRange } from '@/lib/hk-date'
import { calculateTimeBank } from '@/lib/payroll-engine'

// ============================================================
// GET /api/my/summary — Monthly summary (hours/OT/leave)
// All roles — returns the current employee's summary
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { searchParams } = new URL(req.url)
  const month = searchParams.get('month')

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  let targetMonth: string
  if (month) {
    targetMonth = month
  } else {
    const now = new Date()
    targetMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  }

  const { start: monthStart, end: monthEnd } = getMonthRange(new Date(`${targetMonth}-01T00:00:00+08:00`))

  // ★ 決定（2026-08-01）：員工首頁同薪資單／考勤用【同一個數】。
  //   calculateTimeBank 內部自己查 pay rule，傳 {} 冇問題（只影響 negative_carry）。
  const monthDate = new Date(`${targetMonth}-01T00:00:00+08:00`)
  const tb = await calculateTimeBank(employee.id, monthDate, {}, prisma)

  const shiftCount = (await prisma.shift.count({
    where: { employeeId: employee.id, date: { gte: monthStart, lte: monthEnd } },
  }))

  const punches = await prisma.punchRecord.findMany({
    where: { employeeId: employee.id, punchTime: { gte: monthStart, lt: monthEnd }, void: { is: null } },
  })

  const clockIns = punches.filter(p => p.punchType === 'CLOCK_IN')
  const clockOuts = punches.filter(p => p.punchType === 'CLOCK_OUT')

  const leaveRequests = await prisma.leaveRequest.findMany({
    where: {
      employeeId: employee.id,
      status: 'APPROVED',
      // ★ 跨月假期：startDate <= 月尾 AND endDate >= 月初
      startDate: { lte: monthEnd },
      endDate: { gte: monthStart },
    },
    include: { leaveType: { select: { name: true, isPaid: true } } },
  })

  // ★ 按日去重 + 只計本月佔嘅日數
  const monthStartStr = toHKDateStr(monthStart)
  const monthEndStr = toHKDateStr(monthEnd)
  const leaveDateSet = new Set<string>()
  for (const r of leaveRequests) {
    let cur = toHKDateStr(r.startDate)
    const last = toHKDateStr(r.endDate)
    while (cur <= last) {
      if (cur >= monthStartStr && cur <= monthEndStr) leaveDateSet.add(cur)
      cur = toHKDateStr(new Date(hkDateStart(cur).getTime() + 86400000))
    }
  }
  const totalLeaveDays = leaveDateSet.size

  const corrections = await prisma.punchCorrection.count({
    where: { employeeId: employee.id, status: 'APPROVED' },
  })

  return NextResponse.json({
    month: targetMonth,
    summary: {
      punchCount: punches.length,
      clockInCount: clockIns.length,
      clockOutCount: clockOuts.length,
      shiftCount,
      leaveDays: totalLeaveDays,
      lateCount: (tb.dailyLate ?? []).length,
      lateMinutes: tb.netLateMinutes, // 已扣補鐘
      earlyLeaveMinutes: tb.netEarlyMinutes,
      otMinutes: tb.otMinutes,
      earlyInOtMinutes: tb.earlyInOtMinutes,
      netLateMinutes: tb.netLateMinutes,
      netEarlyMinutes: tb.netEarlyMinutes,
      makeupMinutes: tb.makeupMinutes,
      netOtThisMonth: tb.netOtThisMonth,
      timeAccountMinutes: tb.timeAccountMinutes,
      leaveRequests: leaveRequests.map(r => ({
        type: r.leaveType.name,
        days: r.days,
        isPaid: r.leaveType.isPaid,
        startDate: toHKDateStr(r.startDate),
        endDate: toHKDateStr(r.endDate),
      })),
      correctionsCount: corrections,
    },
  })
}
