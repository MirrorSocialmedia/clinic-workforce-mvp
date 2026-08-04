export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { serviceMonths, totalAccruedLeave, accruedBirthdayLeave, PROBATION_MONTHS, resolveLeaveTable } from '@/lib/leave-calculation'
import { LEAVE_SYSTEM_KEYS, allowsNegativeBalance } from '@/lib/leave-types'

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
      ? [await prisma.employee.findUnique({ where: { id: employeeId }, include: { user: { select: { name: true } }, payRules: { where: { isActive: true }, orderBy: { effectiveFrom: 'desc' }, take: 1, select: { configJson: true } } } })].filter(Boolean)
      : await prisma.employee.findMany({
        where: { status: { in: ['ACTIVE', 'PROBATION'] } },
        include: { user: { select: { name: true } }, payRules: { where: { isActive: true }, orderBy: { effectiveFrom: 'desc' }, take: 1, select: { configJson: true } } },
      })

    if (targetEmployees.length === 0) {
      return NextResponse.json({ error: '未找到目標員工' }, { status: 400 })
    }

    const now = new Date()
    let updated = 0
    const skipped: Array<{ employeeId: string; name: string; reason: string }> = []

    for (const emp of targetEmployees as any[]) {
      if (!emp.joinDate) {
        skipped.push({ employeeId: emp.id, name: emp.user?.name ?? '?', reason: '未設定入職日期' })
        continue
      }

      const months = serviceMonths(new Date(emp.joinDate), now)
      if (months < PROBATION_MONTHS) {
        skipped.push({ employeeId: emp.id, name: emp.user?.name ?? '?', reason: `試用期中（到職 ${months} 個月）` })
        continue
      }

      // ★ 2026-08-03：年假按月比例累積（公司政策），日常顯示同離職結算同一口徑
      // ★ 2026-08-04：讀 PayRule 自訂年假階梯（resolveLeaveTable 自動保護法定底線）
      let leaveTable: number[] | undefined
      try {
        const rule = emp.payRules?.[0]
        const cfg = rule && rule.configJson ? JSON.parse(rule.configJson) : {}
        const t = cfg?.modifiers?.annual_leave?.table
        if (Array.isArray(t) && t.length) leaveTable = resolveLeaveTable(t)
      } catch { /* config 壞咗就用法定 */ }

      const entitledNow = totalAccruedLeave(new Date(emp.joinDate), now, 'prorata', leaveTable)

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
        // ★ 2026-08-04：休息日可預支（負餘額）—— 唔 clamp 到 0，
        //   否則撳一次「重新計算」就洗走咗員工欠公司嘅天數。
        const nextRemaining = allowsNegativeBalance(annualLeaveType.systemKey)
          ? entitledNow - existing.used
          : Math.max(0, entitledNow - existing.used)
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

      // ★ 2026-08-04：生日假獨立計算
      const rule = emp.payRules?.[0]
      let birthdayDays = 0
      try {
        const cfg = rule && rule.configJson ? JSON.parse(rule.configJson) : {}
        birthdayDays = cfg?.modifiers?.birthday_leave?.days_per_year ?? 0
      } catch { /* config 壞咗就當冇生日假 */ }

      if (birthdayDays > 0) {
        const birthdayType = await prisma.leaveType.findUnique({
          where: { systemKey: LEAVE_SYSTEM_KEYS.BIRTHDAY },
        })
        if (birthdayType) {
          const birthdayEntitled = accruedBirthdayLeave(new Date(emp.joinDate), now, birthdayDays)
          const birthdayExisting = await prisma.leaveBalance.findUnique({
            where: {
              employeeId_leaveTypeId_year: {
                employeeId: emp.id,
                leaveTypeId: birthdayType.id,
                year: 0, // ★ year: 0 累積制
              },
            },
          })

          if (birthdayExisting) {
            if (birthdayExisting.entitled !== birthdayEntitled || birthdayExisting.remaining !== Math.max(0, birthdayEntitled - birthdayExisting.used)) {
              await prisma.leaveBalance.update({
                where: { id: birthdayExisting.id },
                data: { entitled: birthdayEntitled, remaining: Math.max(0, birthdayEntitled - birthdayExisting.used) },
              })
              updated++
            }
          } else if (birthdayEntitled > 0) {
            await prisma.leaveBalance.create({
              data: { employeeId: emp.id, leaveTypeId: birthdayType.id, year: 0, entitled: birthdayEntitled, used: 0, remaining: birthdayEntitled },
            })
            updated++
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      updatedCount: updated,
      employeeCount: targetEmployees.length,
      skipped,
    })
  } catch (error) {
    console.error('Refresh leave balance error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
