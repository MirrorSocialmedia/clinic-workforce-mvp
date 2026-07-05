import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { verifyToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { prisma, withAudit } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// GET /api/users — list users (OWNER only)
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (session.role !== CONFIG.ROLES.OWNER) {
    return NextResponse.json({ error: 'Forbidden: OWNER only' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const role = searchParams.get('role')
  const status = searchParams.get('status')

  const where: any = {}
  if (role) where.role = role
  if (status) where.status = status

  const users = await prisma.user.findMany({
    where,
    include: {
      clinics: { include: { clinic: true } },
      employee: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  // Exclude password from response
  const safeUsers = users.map(({ password, ...user }) => user)

  return NextResponse.json({ users: safeUsers, total: safeUsers.length })
}

// POST /api/users — create user (OWNER only)
export async function POST(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (session.role !== CONFIG.ROLES.OWNER) {
    return NextResponse.json({ error: 'Forbidden: OWNER only' }, { status: 403 })
  }

  setAuditContext(session.userId, req.headers.get('x-forwarded-for') || '', req.headers.get('user-agent') || '')

  const { name, phone, email, password, role, clinicIds, assignEmployee = false } = await req.json()

  if (!name || !phone || !password || !role) {
    return NextResponse.json({ error: 'Name, phone, password, and role are required' }, { status: 400 })
  }

  // Check phone uniqueness
  const existing = await prisma.user.findUnique({ where: { phone } })
  if (existing) {
    return NextResponse.json({ error: 'Phone already registered' }, { status: 409 })
  }

  const hashedPassword = await bcrypt.hash(password, 12)

  const clinicData = clinicIds && clinicIds.length > 0
    ? { create: clinicIds.map((cid: string, idx: number) => ({ clinic: { connect: { id: cid } }, isPrimary: idx === 0 })) }
    : undefined

  const user = await withAudit(
    prisma.user.create({
      data: {
        name,
        phone,
        email: email || null,
        password: hashedPassword,
        role,
        clinics: clinicData,
      },
      include: { clinics: { include: { clinic: true } } },
    }),
    'User'
  )

  // Optionally create Employee record
  if (assignEmployee) {
    await withAudit(
      prisma.employee.create({
        data: {
          userId: user.id,
          joinDate: new Date(),
          status: 'ACTIVE',
        },
      }),
      'Employee'
    )
  }

  const { password: _pwd, ...safeUser } = user
  return NextResponse.json({ success: true, user: safeUser }, { status: 201 })
}
