export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/employees — list employees with filters
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const role = searchParams.get('role')
  const status = searchParams.get('status')
  const search = searchParams.get('search')
  const page = parseInt(searchParams.get('page') || '1')
  const pageSize = parseInt(searchParams.get('pageSize') || '20')
  const skip = (page - 1) * pageSize

  const where: any = {}

  if (clinicId) {
    where.clinics = { some: { clinicId } }
  }

  if (status) {
    where.status = status
  }

  if (search) {
    where.user = {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ],
    }
  }

  // Non-OWNER roles filter by clinic access
  if (scope !== 'all') {
    where.user = {
      ...(where.user || {}),
      clinics: { some: { clinicId: { in: session.clinics } } },
    }
  }

  const [employees, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, phone: true, email: true } },
        clinics: {
          include: { clinic: { select: { id: true, name: true } } },
        },
        payRules: {
          where: { isActive: true },
          orderBy: { effectiveFrom: 'desc' },
          take: 1,
          select: { payType: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.employee.count({ where }),
  ])

  return NextResponse.json({
    employees,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  })
}

// ============================================================
// POST /api/employees — create employee
// Roles: OWNER, MANAGER
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()
      const {
        name,
        phone,
        email,
        password,
        clinicIds,
        joinDate,
        payType,
        baseAmount,
        configJson,
        effectiveFrom,
      } = body

      // Validate required fields
      if (!name || !phone || !password) {
        return NextResponse.json(
          { error: 'Name, phone, and password are required' },
          { status: 400 }
        )
      }

      if (!clinicIds || clinicIds.length === 0) {
        return NextResponse.json(
          { error: 'At least one clinic is required' },
          { status: 400 }
        )
      }

      // Check phone uniqueness
      const existingUser = await prisma.user.findUnique({ where: { phone } })
      if (existingUser) {
        return NextResponse.json(
          { error: 'Phone already registered' },
          { status: 409 }
        )
      }

      const hashedPassword = await bcrypt.hash(password, 12)

      // Transaction: create user + employee + audit log
      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name,
            phone,
            email: email || null,
            password: hashedPassword,
            role: 'EMPLOYEE',
            clinics: {
              create: clinicIds.map((cid: string, idx: number) => ({
                clinic: { connect: { id: cid } },
                isPrimary: idx === 0,
              })),
            },
          },
          include: {
            clinics: { include: { clinic: { select: { id: true, name: true } } } },
          },
        })

        const employeeData: any = {
          userId: user.id,
          joinDate: joinDate ? new Date(joinDate) : new Date(),
          status: 'ACTIVE',
        }

        employeeData.clinics = {
          create: clinicIds.map((cid: string, idx: number) => ({
            clinic: { connect: { id: cid } },
            isPrimary: idx === 0,
          })),
        }

        if (payType) {
          employeeData.payRules = {
            create: {
              payType,
              baseAmount: baseAmount ?? null,
              configJson: configJson || null,
              effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
              createdBy: session.userId,
            },
          }
        }

        const employee = await tx.employee.create({
          data: employeeData,
          include: {
            user: { select: { id: true, name: true, phone: true, email: true } },
            clinics: { include: { clinic: { select: { id: true, name: true } } } },
            payRules: true,
          },
        })

        return employee
      })

      return NextResponse.json({ success: true, employee: result }, { status: 201 })
    } catch (error) {
      console.error('Create employee error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
