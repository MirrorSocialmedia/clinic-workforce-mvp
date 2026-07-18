export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { serviceMonths, serviceYears, annualLeaveEntitlement, PROBATION_MONTHS } from '@/lib/leave-calculation'
import { toHKDateStr } from '@/lib/hk-date'

/**
 * POST /api/leave-balance/refresh
 *
 * 重新計算指定員工（或在職全部）的年假 LeaveBalance。
 * 按服務年度逐筆 upsert，保留已用天數。
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
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
    const currentYear = parseInt(toHKDateStr(now).slice(0, 4))
    let updated = 0
    const skipped: string[] = []

    for (const emp of targetEmployees as any[]) {
      if (!emp.joinDate) { skipped.push(emp.id); continue }

      // 試用期檢查：不足 3 個月 → 0
      const months = serviceMonths(new Date(emp.joinDate), now)
      if (months < PROBATION_MONTHS) {
        skipped.push(emp.id)
        continue
      }

      // 週年發放制：已滿整年數
      const completedYears = serviceYears(new Date(emp.joinDate), now)
      // 滿 1 年=7、滿 2 年=7、滿 3 年=8 … 滿 9 年+=14；未滿 1 年=0
      const entitledNow = completedYears >= 1
        ? annualLeaveEntitlement(completedYears)
        : 0

      const existing = await prisma.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: emp.id,
            leaveTypeId: annualLeaveTypeId,
            year: currentYear,
          },
        },
      })

      if (existing) {
        const delta = entitledNow - existing.entitled
        if (delta !== 0) {
          // 冪等：額沒變就不動；有變化則差額進 remaining，已用不受影響
          await prisma.leaveBalance.update({
            where: { id: existing.id },
            data: { entitled: entitledNow, remaining: { increment: delta } },
          })
          updated++
        }
      } else {
        await prisma.leaveBalance.create({
          data: {
            employeeId: emp.id,
            leaveTypeId: annualLeaveTypeId,
            year: currentYear,
            entitled: entitledNow,
            used: 0,
            remaining: entitledNow,
          },
        })
        updated++
      }
    }

    return NextResponse.json({
      success: true,
      refreshedCount: updated,
      updatedCount: updated,
      employeeCount: targetEmployees.length,
      skipped: skipped.length,
    })
  } catch (error) {
    console.error('Refresh leave balance error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
