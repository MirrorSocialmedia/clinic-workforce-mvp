export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { settleLeaveOnResign, isInProbation, LeaveSettlement } from '@/lib/leave-calculation'

/**
 * POST /api/leave-settlement
 *
 * 離職年假結算 API。
 * - 輸入：employeeId, resignDate, monthlySalary
 * - 輸出：LeaveSettlement（accrued / used / unused / payout）
 *
 * 規則：
 * - 不足 3 個月服務 → 全部歸零
 * - 滿 3 個月 → 未放部分按月薪折算
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  if (session.role !== 'OWNER' && session.role !== 'MANAGER' && session.role !== 'ACCOUNTANT') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { employeeId, resignDate, monthlySalary } = body

    if (!employeeId || !resignDate || monthlySalary === undefined) {
      return NextResponse.json(
        { error: 'employeeId, resignDate, and monthlySalary are required' },
        { status: 400 },
      )
    }

    if (typeof monthlySalary !== 'number' || monthlySalary <= 0) {
      return NextResponse.json(
        { error: 'monthlySalary must be a positive number' },
        { status: 400 },
      )
    }

    // 取得員工資料
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { user: { select: { name: true } } },
    })
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 })
    }

    if (!employee.joinDate) {
      return NextResponse.json({ error: 'Employee has no joinDate' }, { status: 400 })
    }

    const joinDate = new Date(employee.joinDate)
    const resign = new Date(resignDate)

    // 試用期內不足 3 個月 → 歸零
    if (isInProbation(joinDate, resign)) {
      return NextResponse.json({
        employeeId,
        joinDate: joinDate.toISOString(),
        resignDate: resign.toISOString(),
        probation: true,
        settlement: { accrued: 0, used: 0, unused: 0, payout: 0 },
      })
    }

    // 計算已用年假天數
    const usedDays = await calculateUsedAnnualLeave(employeeId, joinDate, resign)

    // 結算
    const settlement: LeaveSettlement = settleLeaveOnResign(
      joinDate,
      resign,
      monthlySalary,
      usedDays,
    )

    return NextResponse.json({
      employeeId,
      employeeName: employee.user?.name ?? 'Unknown',
      joinDate: joinDate.toISOString(),
      resignDate: resign.toISOString(),
      monthlySalary,
      usedDays,
      settlement,
    })
  } catch (error) {
    console.error('Leave settlement error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * 計算員工已使用的年假天數（從入職到離職日期範圍內所有已批准的請假）
 */
async function calculateUsedAnnualLeave(
  employeeId: string,
  joinDate: Date,
  resignDate: Date,
): Promise<number> {
  // 找到所有年假類型
  const annualLeaveTypes = await prisma.leaveType.findMany({
    where: {
      isActive: true,
      OR: [
        { name: { contains: '年假' } },
        { name: { contains: 'Annual', mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  })

  if (annualLeaveTypes.length === 0) return 0

  const leaveTypeIds = annualLeaveTypes.map((lt) => lt.id)

  // 取得所有已批准的年假申請
  const approvedRequests = await prisma.leaveRequest.findMany({
    where: {
      employeeId,
      leaveTypeId: { in: leaveTypeIds },
      status: 'APPROVED',
      endDate: { lte: resignDate },
    },
    select: { days: true },
  })

  return approvedRequests.reduce((sum, r) => sum + r.days, 0)
}
