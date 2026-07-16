export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { serviceMonths, serviceYears, leaveForServiceYear, PROBATION_MONTHS } from '@/lib/leave-calculation'

/**
 * POST /api/leave-balance/refresh
 *
 * 重新計算指定員工（或在職全部）的年假 LeaveBalance。
 * 按服務年度逐筆 upsert，保留已用天數。
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  if (session.role !== 'OWNER' && session.role !== 'MANAGER') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const { employeeId } = body

    // 找到所有年假類型的 LeaveType
    const annualLeaveType = await prisma.leaveType.findUnique({
      where: { systemKey: 'ANNUAL_LEAVE' },
    })

    if (!annualLeaveType) {
      return NextResponse.json({ error: '未找到年假類型的 LeaveType (ANNUAL_LEAVE)' }, { status: 400 })
    }

    const annualLeaveTypeId = annualLeaveType.id

    // 取得目標員工列表
    const targetEmployees = employeeId
      ? [await prisma.employee.findUnique({ where: { id: employeeId } })].filter(Boolean)
      : await prisma.employee.findMany({ where: { status: { in: ['ACTIVE', 'PROBATION'] } } })

    if (targetEmployees.length === 0) {
      return NextResponse.json({ error: '未找到目標員工' }, { status: 400 })
    }

    const now = new Date()
    let refreshedCount = 0

    for (const emp of targetEmployees as any[]) {
      if (!emp.joinDate) continue

      const months = serviceMonths(new Date(emp.joinDate), now)
      if (months < PROBATION_MONTHS) continue

      const years = serviceYears(new Date(emp.joinDate), now)

      for (let i = 0; i <= years; i++) {
        const yearNum = new Date(emp.joinDate).getUTCFullYear() + i
        const accrued = leaveForServiceYear(new Date(emp.joinDate), i, now)

        // 先查詢現有記錄，保留已用天數
        const existing = await prisma.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: {
              employeeId: emp.id,
              leaveTypeId: annualLeaveTypeId,
              year: yearNum,
            },
          },
        })

        const used = existing?.used ?? 0

        await prisma.leaveBalance.upsert({
          where: {
            employeeId_leaveTypeId_year: {
              employeeId: emp.id,
              leaveTypeId: annualLeaveTypeId,
              year: yearNum,
            },
          },
          update: {
            entitled: accrued,
            remaining: Math.max(0, accrued - used),
          },
          create: {
            employeeId: emp.id,
            leaveTypeId: annualLeaveTypeId,
            year: yearNum,
            entitled: accrued,
            used: 0,
            remaining: accrued,
          },
        })

        refreshedCount++
      }
    }

    return NextResponse.json({
      success: true,
      refreshedCount,
      employeeCount: targetEmployees.length,
    })
  } catch (error) {
    console.error('Refresh leave balance error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
