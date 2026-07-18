export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma, basePrisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/users — list users (OWNER only)
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const role = searchParams.get('role')
  const status = searchParams.get('status')

  const where: any = {}
  if (role) where.role = role
  if (status) where.status = status

  const users = await prisma.user.findMany({
    where,
    include: { clinics: { include: { clinic: true } }, employee: true },
    orderBy: { createdAt: 'asc' },
  })

  const safeUsers = users.map(({ password, ...user }) => user)
  return NextResponse.json({ users: safeUsers, total: safeUsers.length })
}

// POST /api/users — create user (OWNER only)
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const { name, phone, email, password, role, clinicIds, assignEmployee = false } = await req.json()

      if (!name || !phone || !password || !role) {
        return NextResponse.json({ error: 'Name, phone, password, and role are required' }, { status: 400 })
      }

      const existing = await prisma.user.findUnique({ where: { phone } })
      if (existing) {
        return NextResponse.json({ error: 'Phone already registered' }, { status: 409 })
      }

      const hashedPassword = await bcrypt.hash(password, 12)

      const clinicData = clinicIds && clinicIds.length > 0
        ? { create: clinicIds.map((cid: string, idx: number) => ({ clinic: { connect: { id: cid } }, isPrimary: idx === 0 })) }
        : undefined

      // FIX #1: Use $transaction — user create + audit in same transaction
      const user = await basePrisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            name, phone, email: email || null, password: hashedPassword, role, clinics: clinicData,
          },
          include: { clinics: { include: { clinic: true } } },
        })

        // Manual audit inside same transaction
        await tx.auditLog.create({
          data: {
            actorId: auditCtx.actorId,
            action: 'CREATE',
            entity: 'User',
            entityId: created.id,
            afterJson: JSON.stringify(created),
            notes: `User created: role=${role}`,
            ipAddress: auditCtx.ip || null,
            userAgent: auditCtx.ua || null,
          },
        })

        return created
      })

      if (assignEmployee) {
        await prisma.employee.create({
          data: { userId: user.id, joinDate: new Date(), status: 'ACTIVE' },
        })
      }

      const { password: _pwd, ...safeUser } = user
      return NextResponse.json({ success: true, user: safeUser }, { status: 201 })
    } catch (error) {
      console.error('Create user error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
