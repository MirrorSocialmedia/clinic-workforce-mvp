export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/leave-balance — Get leave balance
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// Employee sees own; managers see all (optionally filtered by employeeId)
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const year = searchParams.get('year')

  let targetEmployeeId: string | undefined

  // Employees only see their own balance
  if (scope === 'self') {
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    if (!emp) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })
    targetEmployeeId = emp.id
  } else if (employeeId) {
    targetEmployeeId = employeeId
  }

  const where: any = targetEmployeeId ? { employeeId: targetEmployeeId } : {}
  if (year) where.year = parseInt(year)

  const balances = await prisma.leaveBalance.findMany({
    where,
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, annualQuota: true, color: true } },
      employee: {
        include: { user: { select: { id: true, name: true } } },
      },
    },
    orderBy: [{ year: 'desc' }, { leaveType: { name: 'asc' } }],
  })

  return NextResponse.json({ leaveBalances: balances })
}

// ============================================================
// PATCH /api/leave-balance — Update leave balance (entitled/remaining)
// Roles: OWNER, MANAGER
// ============================================================
export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req, 'PATCH', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  if (session.role !== 'OWNER' && session.role !== 'MANAGER') {
    return NextResponse.json({ error: 'Only managers can update leave balances' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const { balanceId, entitled, remaining } = body

    if (!balanceId) {
      return NextResponse.json({ error: 'balanceId is required' }, { status: 400 })
    }

    const updateData: any = {}
    if (entitled !== undefined) updateData.entitled = entitled
    if (remaining !== undefined) updateData.remaining = remaining

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const updated = await prisma.leaveBalance.update({
      where: { id: balanceId },
      data: updateData,
      include: {
        leaveType: { select: { id: true, name: true } },
        employee: { include: { user: { select: { id: true, name: true } } } },
      },
    })

    return NextResponse.json({ success: true, leaveBalance: updated })
  } catch (error) {
    console.error('Update leave balance error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============================================================
// DELETE /api/leave-balance — Clear leave balances
// Roles: OWNER
// ============================================================
export async function DELETE(req: NextRequest) {
  const auth = requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  if (session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const year = parseInt(searchParams.get('year') || '0')

  if (!year) return NextResponse.json({ error: '需要年份参数' }, { status: 400 })

  const deleted = await prisma.leaveBalance.deleteMany({
    where: {
      ...(employeeId && employeeId !== 'all' ? { employeeId } : {}),
      year,
    },
  })

  // 審計記錄
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'DELETE',
      entity: 'LeaveBalance',
      entityId: 'batch',
      notes: `清除假期資料: ${employeeId === 'all' ? '全部員工' : employeeId}, 年份 ${year}, 共 ${deleted.count} 筆`,
    },
  })

  return NextResponse.json({ count: deleted.count })
}
