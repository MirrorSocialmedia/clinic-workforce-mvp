export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { createNotification } from '@/lib/notification'
import { isInProbation } from '@/lib/leave-calculation'
import { ensureRestDayGranted } from '@/lib/payroll-engine'

// ============================================================
// GET /api/leave-requests — List leave requests
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// EMPLOYEE sees only own; managers see all (filtered by clinic for MANAGER)
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
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
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    if (emp) {
      where.employeeId = emp.id
    }
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

  return NextResponse.json({ leaveRequests: requests })
}

// ============================================================
// POST /api/leave-requests — Create leave request
// Roles: OWNER, MANAGER, EMPLOYEE
// ============================================================
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

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
      if (requestBodyEmployeeId) {
        if (session.role !== 'OWNER' && session.role !== 'MANAGER') {
          return NextResponse.json({ error: 'Only managers can create leave for other employees' }, { status: 403 })
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

      // 🔧 Ensure REST_DAY monthly quota exists before balance check (cross-month lazy grant)
      if (leaveType.systemKey === 'REST_DAY') {
        await ensureRestDayGranted(employee.id, new Date(startDate), prisma)
        if (toHKDateStr(new Date(endDate)).slice(0, 7) !== toHKDateStr(new Date(startDate)).slice(0, 7)) {
          await ensureRestDayGranted(employee.id, new Date(endDate), prisma)
        }
      }

      // Validate remaining balance (skip for unlimited types)
      const currentYear = new Date().getUTCFullYear()
      const balance = await prisma.leaveBalance.findFirst({
        where: { employeeId: employee.id, leaveTypeId, year: currentYear },
      })

      if (!isUnlimited && balance && leaveType.annualQuota !== null && leaveType.annualQuota > 0) {
        if (days > balance.remaining) {
          return NextResponse.json(
            { error: `Insufficient leave balance. Remaining: ${balance.remaining} days` },
            { status: 400 }
          )
        }
      }

      const isApprover = session.role === 'OWNER' || session.role === 'MANAGER'

      // Fix #5: check for overlapping leave (PENDING or APPROVED)
      const overlap = await prisma.leaveRequest.findFirst({
        where: {
          employeeId: employee.id,
          status: { in: ['PENDING', 'APPROVED'] },
          startDate: { lte: new Date(endDate) },
          endDate: { gte: new Date(startDate) },
        },
      })
      if (overlap) {
        return NextResponse.json(
          { error: '該日期範圍已有請假申請' },
          { status: 409 }
        )
      }

      // Fix: check shift conflict before auto-approving
      if (isApprover) {
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

      // Transaction: create request (audit handled by Prisma extension)
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

        return req
      })

      // If auto-approved, deduct from balance + notify (skip for unlimited types)
      if (request.status === 'APPROVED' && !isUnlimited) {
        await deductLeaveBalance(employee.id, leaveTypeId, days)
        await createNotification({
          employeeId: employee.id,
          type: 'LEAVE_APPROVED',
          content: `Your ${leaveType.name} request (${days} days) has been approved.`,
          relatedEntity: 'LeaveRequest',
          relatedId: request.id,
        })
      }

      return NextResponse.json({ success: true, leaveRequest: request }, { status: 201 })
    } catch (error) {
      console.error('Leave request error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}

function isAnnualLeave(leaveType: { name: string }): boolean {
  const lower = leaveType.name.toLowerCase()
  return lower.includes('年假') || lower.includes('annual leave') || lower.includes('annual')
}

async function deductLeaveBalance(employeeId: string, leaveTypeId: string, days: number): Promise<void> {
  // 🔧 Ensure REST_DAY monthly quota before deduction
  const lt = await prisma.leaveType.findUnique({ where: { id: leaveTypeId }, select: { systemKey: true } })
  if (lt?.systemKey === 'REST_DAY') {
    await ensureRestDayGranted(employeeId, new Date(), prisma)
  }

  const currentYear = new Date().getUTCFullYear()
  const bal = await prisma.leaveBalance.findUnique({
    where: {
      employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: currentYear },
    },
  })
  if (!bal || bal.remaining < days) {
    throw new Error(`Insufficient leave balance. Requested: ${days}, Remaining: ${bal?.remaining ?? 0}`)
  }
  await prisma.leaveBalance.update({
    where: {
      employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: currentYear },
    },
    data: {
      used: { increment: days },
      remaining: { decrement: days },
    },
  })
}
