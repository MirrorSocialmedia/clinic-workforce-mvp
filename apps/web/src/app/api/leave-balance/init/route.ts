export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// POST /api/leave-balance/init — Batch initialize leave balances
// Roles: OWNER, MANAGER
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  if (session.role !== 'OWNER' && session.role !== 'MANAGER') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { employeeId, leaveTypeId, days, year } = body

    if (!leaveTypeId || !days || !year) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 })
    }

    const targets = employeeId === 'all'
      ? (await prisma.employee.findMany()).map(e => e.id)
      : [employeeId]

    const results = []
    for (const empId of targets) {
      // Read original values before upsert
      const before = await prisma.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: { employeeId: empId, leaveTypeId, year },
        },
      })

      const result = await prisma.leaveBalance.upsert({
        where: {
          employeeId_leaveTypeId_year: { employeeId: empId, leaveTypeId, year },
        },
        update: { entitled: days, remaining: days, used: 0 },
        create: { employeeId: empId, leaveTypeId, year, entitled: days, remaining: days, used: 0 },
      })

      // ★ Write audit log: LEAVE_INIT
      await prisma.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'LEAVE_INIT',
          entity: 'LeaveBalance',
          entityId: empId,
          targetEmployeeId: empId,
          beforeJson: JSON.stringify({ entitled: before?.entitled ?? null, remaining: before?.remaining ?? null }),
          afterJson: JSON.stringify({ entitled: days, remaining: days }),
          notes: JSON.stringify({ leaveTypeId, year, days }),
        },
      })

      results.push(result)
    }

    return NextResponse.json({ count: results.length })
  } catch (error) {
    console.error('Init leave balance error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
