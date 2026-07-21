export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER')
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
    const shifts = await tx.shift.updateMany({
      where: {
        employeeId: empId,
        date: { gt: cutoff },
        status: { not: 'CANCELLED' },
      },
      data: { status: 'CANCELLED' },
    })

    // Cancel future approved leaves
    const leaves = await tx.leaveRequest.updateMany({
      where: {
        employeeId: empId,
        startDate: { gt: cutoff },
        status: 'APPROVED',
      },
      data: { status: 'CANCELLED' },
    })

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
        notes: `離職：最後工作日=${lastDay}, 取消班次=${shifts.count}, 取消假期=${leaves.count}`,
        ipAddress: null,
        userAgent: null,
      } as any,
    })

    return { shiftsCancelled: shifts.count, leavesCancelled: leaves.count }
  })

  return NextResponse.json({ ok: true, ...result })
}
