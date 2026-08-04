export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { createNotification } from '@/lib/notification'
import { isInProbation } from '@/lib/leave-calculation'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { LEAVE_SYSTEM_KEYS, allowsNegativeBalance } from '@/lib/leave-types'

// ★ 餘額不足錯誤 —— 用於在 $transaction 內拋出，catch 層分辨 400 vs 500
class InsufficientBalanceError extends Error {}

// ============================================================
// GET /api/leave-requests — List leave requests
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// EMPLOYEE sees only own; managers see all (filtered by clinic for MANAGER)
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const status = searchParams.get('status')
  const leaveTypeId = searchParams.get('leaveTypeId')
  const clinicId = searchParams.get('clinicId')

  const where: any = {}

  // EMPLOYEE only sees own requests
  if (scope === 'self') {
    const emp = await prisma.employee.findFirst({
      where: { userId: session.userId },
    })
    if (!emp) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })
    // ★ 同上：明确拒绝，唔好静静收窄成自己
    if (employeeId && employeeId !== emp.id) {
      return NextResponse.json(
        { error: 'Forbidden (cannot read other employees\' leave requests)' },
        { status: 403 },
      )
    }
    where.employeeId = emp.id
  }

  if (employeeId && scope !== 'self') where.employeeId = employeeId
  if (status) where.status = status
  if (leaveTypeId) where.leaveTypeId = leaveTypeId
  if (clinicId) where.clinicId = clinicId

  const requests = await prisma.leaveRequest.findMany({
    where,
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, color: true } },
      employee: {
        include: {
          user: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  return NextResponse.json(
    { leaveRequests: requests },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  )
}

// ============================================================
// POST /api/leave-requests — Create leave request
// Roles: OWNER, MANAGER, EMPLOYEE
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope, perms } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()
      const { leaveTypeId, startDate, endDate, days, reason, isPlanned, employeeId: requestBodyEmployeeId, clinicId } = body

      if (!leaveTypeId || !startDate || !endDate || days === undefined || days <= 0) {
        return NextResponse.json(
          { error: 'leaveTypeId, startDate, endDate, and days (positive) are required' },
          { status: 400 }
        )
      }

      // Support manager creating leave for another employee
      let employee: any
      // ★ 排休息日／假期本身就係排班嘅一部分，唔應該淨係 OWNER/MANAGER 做得到。
      //   role 寫死會令有 scheduling 權限嘅員工排唔到。
      if (requestBodyEmployeeId) {
        const canCreateForOthers =
          (perms ?? []).includes('scheduling') || (perms ?? []).includes('leave_approve')
        if (!canCreateForOthers) {
          return NextResponse.json(
            { error: 'Forbidden (missing permission: scheduling / leave_approve)' },
            { status: 403 },
          )
        }
        employee = await prisma.employee.findUnique({ where: { id: requestBodyEmployeeId } })
      } else {
        employee = await prisma.employee.findUnique({ where: { userId: session.userId } })
      }

      if (!employee) {
        return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })
      }

      const leaveType = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } })
      if (!leaveType) {
        return NextResponse.json({ error: 'Leave type not found' }, { status: 404 })
      }

      // 🔧 無限額度：quantity=null 且非 systemKey 的類型不扣餘額
      const isUnlimited = leaveType.quantity == null && !leaveType.systemKey

      // 試用期門檻：年假在試用期內不可申請
      if (isAnnualLeave(leaveType) && employee.joinDate) {
        if (isInProbation(new Date(employee.joinDate))) {
          return NextResponse.json(
            { error: '試用期內不可申請年假' },
            { status: 400 }
          )
        }
      }

      // Validate remaining balance (skip for unlimited types)
      // ★ 年假採累積制，用 year=0；其餘假期用曆年
      const balanceYear = leaveType.systemKey === LEAVE_SYSTEM_KEYS.ANNUAL
        ? 0
        : Number(toHKDateStr(new Date(startDate)).slice(0, 4))
      const balance = await prisma.leaveBalance.findFirst({
        where: { employeeId: employee.id, leaveTypeId, year: balanceYear },
      })

      if (!isUnlimited && balance && leaveType.annualQuota !== null && leaveType.annualQuota > 0) {
        // ★ 2026-08-04：休息日可以預支（餘額可負）—— 員工下個月還。
        //   年假／OT 補假仍然唔可以負。
        const canGoNegative = allowsNegativeBalance(leaveType.systemKey)
        if (leaveType.systemKey !== LEAVE_SYSTEM_KEYS.SICK && !canGoNegative && days > balance.remaining) {
          return NextResponse.json(
            { error: `Insufficient leave balance. Remaining: ${balance.remaining} days` },
            { status: 400 }
          )
        }
      }
      // SICK: 不驗餘額、不扣 balance——成本在計糧端結算

      // ★ 同上：用權限判斷。只修上面唔修呢度，假期會變 PENDING ——
      //   排班總覽唔會當佢係已批假期，該日仍然算缺勤，表面成功但實際冇生效。
      const isApprover =
        (perms ?? []).includes('leave_approve') || (perms ?? []).includes('scheduling')

      // Fix #5: check for overlapping leave (PENDING or APPROVED)
      const overlap = await prisma.leaveRequest.findFirst({
        where: {
          employeeId: employee.id,
          status: { in: ['PENDING', 'APPROVED'] },
          startDate: { lte: new Date(endDate) }, // TZ-OK: LeaveRequest 用 UTC 午夜儲存
          endDate: { gte: new Date(startDate) }, // TZ-OK
        },
      })
      if (overlap) {
        return NextResponse.json(
          { error: '該日期範圍已有請假申請' },
          { status: 409 }
        )
      }

      // ★ 2026-08-02：病假係突發、事後補登，更次應該保留作為
      //   「本來要返工」嘅證據 —— 扣薪要靠佢分辨工作日／休息日。
      //   其餘假期（年假／無薪假／休息日）事先安排，維持「先移除排班」流程。
      const isSickLeave = leaveType.systemKey === 'SICK'

      if (isApprover && !isSickLeave) {
        const conflictShift = await prisma.shift.findFirst({
          where: {
            employeeId: employee.id,
            status: { not: 'CANCELLED' },
            date: {
              gte: new Date(`${toHKDateStr(new Date(startDate))}T00:00:00+08:00`),
              lte: new Date(`${toHKDateStr(new Date(endDate))}T23:59:59+08:00`),
            },
          },
        })
        if (conflictShift) {
          return NextResponse.json(
            { error: `該員工在假期範圍內已有排班（${toHKDateStr(conflictShift.date)}），請先移除排班或改假期日期` },
            { status: 400 }
          )
        }
      }

      // ★ 建立 + 扣餘額 一定要同一個交易 ——
      //   舊寫法交易只包 create，扣餘額失敗會留低一筆已 commit 嘅假期，
      //   前端收到 500 唔會 refresh，結果「格被佔用但冇膠囊」。
      const request = await prisma.$transaction(async (tx) => {
        const req = await tx.leaveRequest.create({
          data: {
            employeeId: employee.id,
            leaveTypeId,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            days,
            reason: reason || null,
            isPlanned: isPlanned !== undefined ? isPlanned : true,
            status: isApprover ? 'APPROVED' : 'PENDING',
            approverId: isApprover ? session.userId : null,
            approvedAt: isApprover ? new Date() : null,
            clinicId: clinicId || null,
          },
          include: {
            leaveType: { select: { id: true, name: true, isPaid: true, color: true } },
          },
        })

        // ★ 扣餘額搬入交易內（SICK 除外 —— 成本喺計糧端結算）
        if (req.status === 'APPROVED' && !isUnlimited && leaveType.systemKey !== LEAVE_SYSTEM_KEYS.SICK) {
          // ★ 年假採累積制，用 year=0；其餘假期用曆年
          const deductYear = leaveType.systemKey === LEAVE_SYSTEM_KEYS.ANNUAL
            ? 0
            : Number(toHKDateStr(new Date(startDate)).slice(0, 4))
          let bal = await tx.leaveBalance.findUnique({
            where: {
              employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId, year: deductYear },
            },
          })

          // ★ 2026-08-04：休息日可預支 —— 冇 row 可創建 0 額度 row 再扣。
          if (!bal) {
            if (allowsNegativeBalance(leaveType.systemKey)) {
              // 冇 row 但可預支 → 建立一個 0 額度嘅 row 再扣
              bal = await tx.leaveBalance.create({
                data: {
                  employeeId: employee.id, leaveTypeId, year: deductYear,
                  entitled: 0, used: 0, remaining: 0,
                },
              })
            } else {
              throw new InsufficientBalanceError(
                `${leaveType.name}未設定額度，請先調整該員工嘅假期額度。`,
              )
            }
          }

          if (!allowsNegativeBalance(leaveType.systemKey) && bal.remaining < days) {
            const hint = leaveType.systemKey === LEAVE_SYSTEM_KEYS.REST_DAY
              ? '請先喺「假期管理 → 發放休息日」為該員工發放，再排班。'
              : '請先調整該員工嘅假期額度。'
            throw new InsufficientBalanceError(
              `${leaveType.name}餘額不足（需 ${days} 天，剩 ${bal?.remaining ?? 0} 天）。${hint}`,
            )
          }

          await tx.leaveBalance.update({
            where: {
              employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId, year: deductYear },
            },
            data: {
              used: { increment: days },
              remaining: { decrement: days },
            },
          })
        }

        return req
      })

      // ★ 通知失敗唔應該令整筆假期失敗 —— 放交易外，包 try/catch
      if (request.status === 'APPROVED') {
        try {
          await createNotification({
            employeeId: employee.id,
            type: 'LEAVE_APPROVED',
            content: `Your ${leaveType.name} request (${days} days) has been approved.`,
            relatedEntity: 'LeaveRequest',
            relatedId: request.id,
          })
        } catch (e) {
          console.error('notify failed', e)
        }
      }

      // ★ 假期影響缺勤判斷同午飯扣減 → 快取要失效
      try {
        await invalidateTimeBankFrom(employee.id, new Date(startDate), prisma)
      } catch (e) {
        console.error(`[timebank-cache] invalidate failed employeeId=${employee.id} date=${new Date(startDate)}`, e)
      }

      return NextResponse.json({ success: true, leaveRequest: request }, { status: 201 })
    } catch (error) {
      console.error('Leave request error:', error)
      // ★ 餘額不足係用家錯誤（400），唔係伺服器錯誤（500）
      if (error instanceof InsufficientBalanceError) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
      return NextResponse.json({ error: '建立假期失敗，請重試' }, { status: 500 })
    }
  })
}

function isAnnualLeave(leaveType: { name: string }): boolean {
  const lower = leaveType.name.toLowerCase()
  return lower.includes('年假') || lower.includes('annual leave') || lower.includes('annual')
}
