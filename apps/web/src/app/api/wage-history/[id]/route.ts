import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// PUT /api/wage-history/[id]
// Update a WageHistory record
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json()
  const { totalWage, excludedDays, excludedWage, note } = body

  const before = await prisma.wageHistory.findUnique({
    where: { id: params.id },
  })
  if (!before) {
    return NextResponse.json({ error: 'WageHistory not found' }, { status: 404 })
  }

  const updated = await prisma.wageHistory.update({
    where: { id: params.id },
    data: {
      ...(totalWage != null && { totalWage: Number(totalWage) }),
      ...(excludedDays != null && { excludedDays: Number(excludedDays) }),
      ...(excludedWage != null && { excludedWage: Number(excludedWage) }),
      ...(note !== undefined && { note }),
    },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: auth.session.userId,
      action: 'WAGE_HISTORY_UPDATE',
      entity: 'WageHistory',
      entityId: updated.id,
      targetEmployeeId: updated.employeeId,
      beforeJson: JSON.stringify({
        totalWage: before.totalWage,
        excludedDays: before.excludedDays,
        excludedWage: before.excludedWage,
      }),
      afterJson: JSON.stringify({
        totalWage: updated.totalWage,
        excludedDays: updated.excludedDays,
        excludedWage: updated.excludedWage,
        periodMonth: updated.periodMonth,
      }),
    } as any,
  })

  return NextResponse.json(updated)
}

// ============================================================
// DELETE /api/wage-history/[id]
// Delete a WageHistory record
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error

  const before = await prisma.wageHistory.findUnique({
    where: { id: params.id },
  })
  if (!before) {
    return NextResponse.json({ error: 'WageHistory not found' }, { status: 404 })
  }

  await prisma.wageHistory.delete({
    where: { id: params.id },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: auth.session.userId,
      action: 'WAGE_HISTORY_DELETE',
      entity: 'WageHistory',
      entityId: before.id,
      targetEmployeeId: before.employeeId,
      beforeJson: JSON.stringify({
        totalWage: before.totalWage,
        excludedDays: before.excludedDays,
        excludedWage: before.excludedWage,
        periodMonth: before.periodMonth,
      }),
    } as any,
  })

  return NextResponse.json({ success: true })
}
