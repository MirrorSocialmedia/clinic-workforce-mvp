export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { settleLeaveOnResign, totalAccruedLeave, serviceMonths } from '@/lib/leave-calculation'
import { hkDateStart } from '@/lib/hk-date'
import { LEAVE_SYSTEM_KEYS } from '@/lib/leave-types'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') // ROLE-OK：離職結算涉及薪金，限 OWNER
    return NextResponse.json({ error: '僅老闆可查看' }, { status: 403 })

  const resolvedParams = await params
  const empId = resolvedParams.id
  const lastDay = new URL(req.url).searchParams.get('lastDay')
  if (!lastDay)
    return NextResponse.json({ error: 'lastDay 必填' }, { status: 400 })

  // ★ 用 hkDateStart 唔好手砌 'T16:00:00Z' —— 後者係硬編碼 UTC+8，
  //   而且 hkDateStart 已經係全系統統一入口。
  const cutoff = hkDateStart(lastDay)

  const [emp, futureShifts, futureLeaves] = await Promise.all([
    prisma.employee.findUnique({
      where: { id: empId },
      include: {
        user: { select: { name: true } },
        payRules: {
          where: { isActive: true },
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
          take: 1,
        },
      },
    }),
    prisma.shift.count({
      where: {
        employeeId: empId,
        date: { gt: cutoff },
        status: { not: 'CANCELLED' },
      },
    }),
    prisma.leaveRequest.count({
      where: {
        employeeId: empId,
        startDate: { gt: cutoff },
        status: 'APPROVED',
      },
    }),
  ])

  if (!emp) return NextResponse.json({ error: '員工不存在' }, { status: 404 })

  // ★ 年假結算 —— 用 'prorata'（EO s.41D：離職時未完成年度按比例）
  //   同日常顯示嘅 'earned'（EO s.41A：可放天數）刻意唔同。
  let leaveSettlement: any = null
  if (emp.joinDate) {
    const annualType = await prisma.leaveType.findUnique({ where: { systemKey: LEAVE_SYSTEM_KEYS.ANNUAL } })
    const bal = annualType
      ? await prisma.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: { employeeId: empId, leaveTypeId: annualType.id, year: 0 },
          },
        })
      : null

    let monthlySalary = 0
    try {
      const cfg = JSON.parse(emp.payRules[0]?.configJson || '{}')
      monthlySalary = Number(cfg?.monthly_salary) || 0
    } catch { /* 壞 JSON 當 0 */ }

    const usedDays = bal?.used ?? 0
    const s = settleLeaveOnResign(new Date(emp.joinDate), cutoff, monthlySalary, usedDays)

    leaveSettlement = {
      joinDate: emp.joinDate,
      serviceMonths: serviceMonths(new Date(emp.joinDate), cutoff),
      earnedNow: totalAccruedLeave(new Date(emp.joinDate), cutoff, 'earned'),
      accrued: s.accrued,
      used: s.used,
      unused: s.unused,
      monthlySalary,
      dailyWage: monthlySalary > 0 ? Math.round((monthlySalary * 12 / 365) * 100) / 100 : 0,
      payout: s.payout,
      isEstimate: monthlySalary === 0,
    }
  }

  return NextResponse.json({ futureShifts, futureApprovedLeaves: futureLeaves, leaveSettlement })
}
