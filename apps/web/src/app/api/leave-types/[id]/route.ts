export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'

// PUT /api/leave-types/[id] — Update leave type
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const body = await req.json()
    const { name, isPaid, annualQuota, color, isActive, cancelsBonus } = body
    const id = params.id

    const existing = await prisma.leaveType.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Leave type not found' }, { status: 404 })

    // Block edits to system leave types (name, isActive cannot be changed)
    if (existing.systemKey) {
      if (name !== undefined && name !== existing.name) {
        return NextResponse.json({ error: '系統假期類型名稱不可修改' }, { status: 400 })
      }
      if (isActive === false) {
        return NextResponse.json({ error: '系統假期類型不可停用' }, { status: 400 })
      }
    }

    if (name && name !== existing.name) {
      const dup = await prisma.leaveType.findFirst({
        where: { name, isActive: true, id: { not: id } },
      })
      if (dup) return NextResponse.json({ error: `Leave type "${name}" already exists` }, { status: 400 })
    }

    const leaveType = await prisma.leaveType.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(isPaid !== undefined && { isPaid }),
        ...(annualQuota !== undefined && { annualQuota }),
        ...(color !== undefined && { color }),
        ...(isActive !== undefined && { isActive }),
        ...(cancelsBonus !== undefined && { cancelsBonus }),
      },
    })

    // Audit handled by Prisma extension (LeaveType ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true, leaveType })
  })
}

// DELETE /api/leave-types/[id] — Delete leave type (blocks system types)
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const existing = await prisma.leaveType.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Leave type not found' }, { status: 404 })

    // Block deletion of system leave types
    if (existing.systemKey) {
      return NextResponse.json({ error: '系統假期類型不可刪除' }, { status: 400 })
    }

    await prisma.leaveType.delete({ where: { id: params.id } })
    return NextResponse.json({ success: true })
  })
}
