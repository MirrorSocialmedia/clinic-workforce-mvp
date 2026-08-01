export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { serviceMonths, totalAccruedLeave, PROBATION_MONTHS } from '@/lib/leave-calculation'
import { LEAVE_SYSTEM_KEYS } from '@/lib/leave-types'

// ★ 年假採累積制（2026-07-31 決定）：year 固定 0，代表「由入職累計」。
//   舊版按曆年開 row，令週年日一過上年未放餘額變孤兒（UI 全部過濾 currentYear）。
const ANNUAL_ACCRUAL_YEAR = 0

/**
 * POST /api/leave-balance/refresh
 *
 * 重新計算指定員工（或在職全部）的年假 LeaveBalance。
 * 累積制：entitled = totalAccruedLeave(joinDate, asOf)，remaining = entitled - used。
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  // ★ 改用權限判斷；權限不足係 403 唔係 401（401 = 未登入，前端會誤導向登入頁）
  if (!(perms ?? []).includes('leave_approve')) {
    return NextResponse.json(
      { error: 'Forbidden (missing permission: leave_approve)' },
      { status: 403 },
    )
  }

  try {
    const body = await req.json().catch(() => ({}))
    const { employeeId } = body

    const annualLeaveType = await prisma.leaveType.findUnique({
      where: { systemKey: LEAVE_SYSTEM_KEYS.ANNUAL },
    })

    if (!annualLeaveType) {
      return NextResponse.json({ error: '未找到年假類型 (ANNUAL_LEAVE)' }, { status: 400 })
    }

    const targetEmployees = employeeId
      ? [await prisma.employee.findUnique({ where: { id: employeeId } })].filter(Boolean)
      : await prisma.employee.findMany({ where: { status: { in: ['ACTIVE', 'PROBATION'] } } })

    if (targetEmployees.length === 0) {
      return NextResponse.json({ error: '未找到目標員工' }, { status: 400 })
    }

    const now = new Date()
    let updated = 0
    const skipped: string[] = []

    for (const emp of targetEmployees as any[]) {
      if (!emp.joinDate) { skipped.push(emp.id); continue }

      const months = serviceMonths(new Date(emp.joinDate), now)
      if (months < PROBATION_MONTHS) { skipped.push(emp.id); continue }

      // ★ 累積制：由入職逐個服務年度按比例加總，未放部分自動結轉
      const entitledNow = totalAccruedLeave(new Date(emp.joinDate), now)

      const existing = await prisma.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: emp.id,
            leaveTypeId: annualLeaveType.id,
            year: ANNUAL_ACCRUAL_YEAR,
          },
        },
      })

      if (existing) {
        // ★ remaining 由 entitled − used 推導，唔可以用 increment delta ——
        //   累積制之下 entitled 持續增長，delta 累加會失準。
        //   used 保留唔動（真實已放天數）。
        const nextRemaining = Math.max(0, entitledNow - existing.used)
        if (existing.entitled !== entitledNow || existing.remaining !== nextRemaining) {
          await prisma.leaveBalance.update({
            where: { id: existing.id },
            data: { entitled: entitledNow, remaining: nextRemaining },
          })
          updated++
        }
      } else {
        await prisma.leaveBalance.create({
          data: {
            employeeId: emp.id,
            leaveTypeId: annualLeaveType.id,
            year: ANNUAL_ACCRUAL_YEAR,
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
      updatedCount: updated,
      employeeCount: targetEmployees.length,
      skipped: skipped.length,
    })
  } catch (error) {
    console.error('Refresh leave balance error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
