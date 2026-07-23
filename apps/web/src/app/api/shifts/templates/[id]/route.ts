export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requirePerm, isAuthError } from '@/lib/require-auth'

// ============================================================
// PUT /api/shifts/templates/[id] — update shift template
// Roles: OWNER, MANAGER
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const template = await prisma.shiftTemplate.findUnique({ where: { id: params.id } })
      if (!template) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 })
      }

      const body = await req.json()
      const { name, shortName, startHour, startMinute, endHour, endMinute, isNightShift, isActive } = body

      const updated = await prisma.shiftTemplate.update({
        where: { id: params.id },
        data: {
          ...(name !== undefined && { name }),
          ...(shortName !== undefined && { shortName }),
          ...(startHour !== undefined && { startHour }),
          ...(startMinute !== undefined && { startMinute }),
          ...(endHour !== undefined && { endHour }),
          ...(endMinute !== undefined && { endMinute }),
          ...(isNightShift !== undefined && { isNightShift }),
          ...(isActive !== undefined && { isActive }),
        },
      })

      return NextResponse.json({ success: true, template: updated })
    } catch (error) {
      console.error('Update template error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}

// ============================================================
// DELETE /api/shifts/templates/[id] — delete shift template
// Roles: OWNER
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const template = await prisma.shiftTemplate.findUnique({ where: { id: params.id } })
      if (!template) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 })
      }

      // Don't allow deleting default templates; just mark inactive instead
      if (template.isDefault) {
        return NextResponse.json({ error: 'Cannot delete default templates' }, { status: 400 })
      }

      // Soft delete: mark as inactive
      await prisma.shiftTemplate.update({
        where: { id: params.id },
        data: { isActive: false },
      })

      return NextResponse.json({ success: true })
    } catch (error) {
      console.error('Delete template error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
