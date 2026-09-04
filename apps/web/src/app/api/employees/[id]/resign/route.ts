export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { balanceYearFor } from '@/lib/leave-types'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { shiftDeletedMsg, buildNotification } from '@/lib/notification-messages'
import { createNotification } from '@/lib/notification'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') // ROLE-OK
    return NextResponse.json({ error: '僅老闆可辦理離職' }, { status: 403 })

  const { lastDay } = await req.json()
  const resolvedParams = await params
  const empId = resolvedParams.id

  const emp = await prisma.employee.findUnique({
    where: { id: empId },
    include: { user: true },
  })

  if (!emp) return NextResponse.json({ error: '員工不存在' }, { status: 404 })

  const cutoff = new Date(`${lastDay}T16:00:00Z`) // HK midnight

  const result = await prisma.$transaction(async (tx) => {
    // ① Employee status → RESIGNED
    await tx.employee.update({
      where: { id: empId },
      data: { status: 'RESIGNED', resignedAt: cutoff },
    })

    // ② User status → INACTIVE + tokenVersion +1 (invalidate all sessions)
    await tx.user.update({
      where: { id: emp.userId },
      data: { status: 'INACTIVE', tokenVersion: { increment: 1 } },
    })

    // ③ Cancel future shifts
    // ★ cwm-resigsettle-20260904：cutoff = 最後工作日翌日 HK 午夜；Shift.date 存工作日 HK 午夜，
    //   所以用 gte（strict > 會漏咗 date 恰好多 cutoff 嗰更）。
    const shifts = await tx.shift.updateMany({
      where: {
        employeeId: empId,
        date: { gte: cutoff },
        status: { not: 'CANCELLED' },
      },
      data: { status: 'CANCELLED' },
    })

    // Cancel future approved leaves
    // ★ 2026-09-02 cwm-resigsettle-20260904：updateMany 攞唔到每筆 days，冇法還額度 →
    //   改 findMany 逐筆處理；取消未放已批假期時 LeaveBalance.used 一定要減返
    //   （同 leave-requests/[id] 撤銷模式一致，否則年假餘額少計 → 尾糧少付）。
    const leavesToCancel = await tx.leaveRequest.findMany({
      where: {
        employeeId: empId,
        startDate: { gte: cutoff },
        status: 'APPROVED',
      },
      select: {
        id: true,
        days: true,
        leaveTypeId: true,
        startDate: true,
        leaveType: { select: { systemKey: true } },
      },
    })
    let leavesCancelled = 0
    for (const lr of leavesToCancel) {
      await tx.leaveRequest.update({
        where: { id: lr.id },
        data: { status: 'CANCELLED' },
      })
      // ★ 年假累積制 = year 0；休息日等 = 曆年（照 leave-requests/[id]:207 口徑）
      const leaveYear = balanceYearFor(lr.leaveType.systemKey, new Date(lr.startDate))
      const updated = await tx.leaveBalance.updateMany({
        where: {
          employeeId: empId,
          leaveTypeId: lr.leaveTypeId,
          year: leaveYear,
        },
        data: { used: { decrement: lr.days }, remaining: { increment: lr.days } },
      })
      // ★ 唔好靜靜吞 —— 還唔到額度係資料錯誤，一定要留痕
      if (updated.count === 0) {
        console.error(
          `[resign] ⛔ 還額度失敗：employeeId=${empId} ` +
          `leaveTypeId=${lr.leaveTypeId} year=${leaveYear} days=${lr.days} leaveRequestId=${lr.id}`,
        )
      }
      leavesCancelled++
    }

    // ④ Deactivate face templates (soft disable, hard delete later after final payroll)
    await tx.faceTemplate.updateMany({
      where: { employeeId: empId, active: true },
      data: { active: false },
    })

    // Audit log
    await tx.auditLog.create({
      data: {
        actorId: auth.session.userId,
        action: 'EMPLOYEE_RESIGN',
        entity: 'Employee',
        entityId: empId,
        targetEmployeeId: empId,
        notes: `離職：最後工作日=${lastDay}, 取消班次=${shifts.count}, 取消假期=${leavesCancelled}`,
        ipAddress: null,
        userAgent: null,
      } as any,
    })

    return { shiftsCancelled: shifts.count, leavesCancelled }
  })

  // ★ 取消未來更次／假期會改變應出勤日 → 清時間帳戶快取（2026-08-10）
  const cutoffDate = cutoff ?? new Date()

  // ★ Notify employee about cancelled future shifts
  const cancelled = await prisma.shift.findMany({
    where: { employeeId: empId, date: { gt: cutoffDate }, status: 'CANCELLED' },
    select: { date: true, startTime: true, endTime: true, clinicId: true },
    orderBy: { date: 'asc' },
  })
  if (cancelled.length > 0) {
    const clinics = await prisma.clinic.findMany({ select: { id: true, name: true } })
    const clinicNameMap = new Map(clinics.map(c => [c.id, c.name]))
    const items = cancelled.map(s => shiftDeletedMsg(s, (cid) => clinicNameMap.get(cid) ?? ''))
    await createNotification(buildNotification(empId, items))
  }

  try {
    await invalidateTimeBankFrom(empId, cutoffDate, prisma)
  } catch (e) {
    console.error('[timebank-cache] invalidate failed on resign', { empId, cutoff: cutoffDate }, e)
  }

  return NextResponse.json({ ok: true, ...result })
}
