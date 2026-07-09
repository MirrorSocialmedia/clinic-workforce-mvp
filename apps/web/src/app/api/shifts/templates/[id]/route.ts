export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// DELETE /api/shifts/templates/[id] — delete shift template
// Roles: OWNER
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  if (session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only owners can delete shift templates' }, { status: 403 })
  }

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
