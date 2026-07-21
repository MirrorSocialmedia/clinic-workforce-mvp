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
    return NextResponse.json({ error: '僅老闆可辦理復職' }, { status: 403 })

  const resolvedParams = await params
  const empId = resolvedParams.id

  const emp = await prisma.employee.findUnique({
    where: { id: empId },
    select: { userId: true },
  })
  if (!emp) return NextResponse.json({ error: '員工不存在' }, { status: 404 })

  await prisma.$transaction(async (tx) => {
    // Employee rehire
    await tx.employee.update({
      where: { id: empId },
      data: { status: 'ACTIVE', resignedAt: null },
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
