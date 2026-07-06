import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'

// PUT /api/leave-types/[id] — Update leave type
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const body = await req.json()
    const { name, isPaid, annualQuota, color, isActive } = body
    const id = params.id

    const existing = await prisma.leaveType.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Leave type not found' }, { status: 404 })

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
      },
    })

    // Audit handled by Prisma extension (LeaveType ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true, leaveType })
  })
}
