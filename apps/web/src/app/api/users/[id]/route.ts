export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { verifyToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { prisma, withAudit } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// PUT /api/users/:id — update user (OWNER only)
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (session.role !== CONFIG.ROLES.OWNER) {
    return NextResponse.json({ error: 'Forbidden: OWNER only' }, { status: 403 })
  }

  setAuditContext(session.userId, req.headers.get('x-forwarded-for') || '', req.headers.get('user-agent') || '')

  const id = params.id
  const { name, phone, email, password, role, status, clinicIds } = await req.json()

  const updateData: any = {}
  if (name) updateData.name = name
  if (email !== undefined) updateData.email = email
  if (role) updateData.role = role
  if (status) updateData.status = status
  if (password) updateData.password = await bcrypt.hash(password, 12)

  // Handle clinic associations
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

  // Handle phone change
  if (phone) {
    const currentUser = await prisma.user.findUnique({ where: { id } })
    if (currentUser && phone !== currentUser.phone) {
      const existing = await prisma.user.findUnique({ where: { phone } })
      if (existing) {
        return NextResponse.json({ error: 'Phone already registered' }, { status: 409 })
      }
      updateData.phone = phone
    }
  }

  const user = await withAudit(
    prisma.user.update({
      where: { id },
      data: updateData,
      include: { clinics: { include: { clinic: true } } },
    }),
    'User'
  )

  const { password: _pwd, ...safeUser } = user
  return NextResponse.json({ success: true, user: safeUser })
}
