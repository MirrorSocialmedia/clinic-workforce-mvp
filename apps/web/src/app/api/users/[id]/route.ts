import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
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

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      include: { clinics: { include: { clinic: true } } },
    })

    const { password: _pwd, ...safeUser } = user
    return NextResponse.json({ success: true, user: safeUser })
  })
}
