export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma, createAuditLog } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// ============================================================
// PUT /api/leave-types/[id] — Update leave type
// Roles: OWNER
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!['OWNER'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  try {
    const body = await req.json()
    const { name, isPaid, annualQuota, color, isActive } = body
    const id = params.id

    const existing = await prisma.leaveType.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Leave type not found' }, { status: 404 })

    // Check name uniqueness (excluding self)
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

    await createAuditLog({
      action: 'UPDATE',
      entity: 'LeaveType',
      entityId: leaveType.id,
      notes: `Updated leave type: ${leaveType.name}`,
    })

    return NextResponse.json({ success: true, leaveType })
  } catch (error) {
    console.error('Leave type update error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
