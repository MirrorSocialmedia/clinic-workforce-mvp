export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma, basePrisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'

// PUT /api/users/:id — update user (OWNER only)
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const id = params.id
    const { name, phone, email, password, role, status, clinicIds } = await req.json()

    const updateData: any = {}
    if (name) updateData.name = name
    if (email !== undefined) updateData.email = email
    if (role) updateData.role = role
    if (status) updateData.status = status
    if (password) updateData.password = await bcrypt.hash(password, 12)

    if (clinicIds) {
      await prisma.userClinic.deleteMany({ where: { userId: id } })
      if (clinicIds.length > 0) {
        updateData.clinics = {
          create: clinicIds.map((cid: string, idx: number) => ({
            clinic: { connect: { id: cid } },
            isPrimary: idx === 0,
          })),
        }
      }
    }

    if (phone) {
      const currentUser = await prisma.user.findUnique({ where: { id } })
      if (currentUser && phone !== currentUser.phone) {
        const existing = await prisma.user.findUnique({ where: { phone } })
        if (existing) return NextResponse.json({ error: 'Phone already registered' }, { status: 409 })
        updateData.phone = phone
      }
    }

    // FIX #1: Use $transaction — user update + audit in same transaction
    const user = await basePrisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: updateData,
        include: { clinics: { include: { clinic: true } } },
      })

      // Manual audit inside same transaction
      await tx.auditLog.create({
        data: {
          actorId: auditCtx.actorId,
          action: 'UPDATE',
          entity: 'User',
          entityId: updated.id,
          afterJson: JSON.stringify(updated),
          notes: `User updated: ${Object.keys(updateData).filter(k => k !== 'password').join(', ')}${role ? ', role=' + role : ''}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })

      return updated
    })

    const { password: _pwd, ...safeUser } = user
    return NextResponse.json({ success: true, user: safeUser })
  })
}
