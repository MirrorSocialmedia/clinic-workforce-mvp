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
  if (auth.session.role !== 'OWNER') // ROLE-OK：復職只能由 OWNER 執行
    return NextResponse.json({ error: '僅老闆可辦理復職' }, { status: 403 })

  const resolvedParams = await params
  const empId = resolvedParams.id

  const emp = await prisma.employee.findUnique({
    where: { id: empId },
    select: { userId: true, status: true },
  })
  if (!emp) return NextResponse.json({ error: '員工不存在' }, { status: 404 })

  // ★ 2026-09-30 [cwm-restdebt] RS-10：同 PUT 復職同一口徑 ——
  //   已有離職結算 → 409（結算未清就復職 = 該月計糧再發一次年假薪酬＋代通知金）
  if (emp.status === 'RESIGNED') {
    const rs = await prisma.resignSettlement.findUnique({ where: { employeeId: empId }, select: { id: true } })
    if (rs) return NextResponse.json({ error: '呢位員工已有離職結算，請先撤銷結算再復職' }, { status: 409 })
  }

  await prisma.$transaction(async (tx) => {
    // Employee rehire
    // ★ 2026-09-30 [cwm-restdebt] RS-10：leaveDate 一齊清（舊版漏 → 復職員工照被當離職計糧）
    await tx.employee.update({
      where: { id: empId },
      data: { status: 'ACTIVE', resignedAt: null, leaveDate: null },
    })

    // User re-enable + new tokenVersion (old tokens stay dead)
    await tx.user.update({
      where: { id: emp.userId },
      data: { status: 'ACTIVE', tokenVersion: { increment: 1 } },
    })

    // Re-enable face templates
    await tx.faceTemplate.updateMany({
      where: { employeeId: empId, active: false },
      data: { active: true },
    })

    // Audit
    await tx.auditLog.create({
      data: {
        actorId: auth.session.userId,
        action: 'EMPLOYEE_REHIRE',
        entity: 'Employee',
        entityId: empId,
        targetEmployeeId: empId,
        notes: '復職',
        ipAddress: null,
        userAgent: null,
      } as any,
    })
  })

  return NextResponse.json({ ok: true })
}
