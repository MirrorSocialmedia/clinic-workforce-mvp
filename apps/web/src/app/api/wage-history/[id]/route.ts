import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError, assertClinicAccess } from '@/lib/require-auth'
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
  const { session, scope } = auth

  const body = await req.json()
  // ★ 兼容 wage（舊前端 key）同 totalWage（DB 欄位名）
  const totalWage = body.totalWage ?? body.wage
  const { excludedDays, excludedWage, note } = body

  // ★ 拒絕空更新 — 避免 Prisma 靜默吞掉無效請求
  const hasChange =
    totalWage != null || excludedDays != null || excludedWage != null || note !== undefined
  if (!hasChange) {
    return NextResponse.json(
      { error: '冇任何可更新欄位（請檢查 body 欄位名：totalWage / excludedDays / excludedWage / note）' },
      { status: 400 },
    )
  }

  const before = await prisma.wageHistory.findUnique({
    where: { id: params.id },
  })
  if (!before) {
    return NextResponse.json({ error: 'WageHistory not found' }, { status: 404 })
  }

  // ★ IDOR: check employee clinic
  const emp = await prisma.employee.findUnique({
    where: { id: before.employeeId },
    select: { homeClinicId: true },
  })
  const denied = assertClinicAccess(scope, session, emp?.homeClinicId)
  if (denied) return denied

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
        periodMonth: before.periodMonth,
        totalWage: before.totalWage,
        excludedDays: before.excludedDays,
        excludedWage: before.excludedWage,
        note: before.note,
      }),
      afterJson: JSON.stringify({
        periodMonth: updated.periodMonth,
        totalWage: updated.totalWage,
        excludedDays: updated.excludedDays,
        excludedWage: updated.excludedWage,
        note: updated.note,
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
  const { session, scope } = auth

  const before = await prisma.wageHistory.findUnique({
    where: { id: params.id },
  })
  if (!before) {
    return NextResponse.json({ error: 'WageHistory not found' }, { status: 404 })
  }

  // ★ IDOR: check employee clinic
  const emp = await prisma.employee.findUnique({
    where: { id: before.employeeId },
    select: { homeClinicId: true },
  })
  const denied = assertClinicAccess(scope, session, emp?.homeClinicId)
  if (denied) return denied

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
