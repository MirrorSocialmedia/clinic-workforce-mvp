import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { verifyToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { prisma, withAudit } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// ============================================================
// GET /api/employees — list employees with filters
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const allowedRoles = ['OWNER', 'MANAGER', 'ACCOUNTANT']
  if (!allowedRoles.includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const role = searchParams.get('role') // Doctor/Nurse/Receptionist/Other
  const status = searchParams.get('status')
  const search = searchParams.get('search')
  const page = parseInt(searchParams.get('page') || '1')
  const pageSize = parseInt(searchParams.get('pageSize') || '20')
  const skip = (page - 1) * pageSize

  const where: any = {}

  // Filter by clinic (via EmployeeClinic join)
  if (clinicId) {
    where.clinics = { some: { clinicId } }
  }

  // Filter by employee status
  if (status) {
    where.status = status
  }

  // Search by name or phone (through user)
  if (search) {
    where.user = {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ],
    }
  }

  // For non-OWNER roles, filter by user's clinic access
  if (session.role !== 'OWNER') {
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
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const allowedRoles = ['OWNER', 'MANAGER']
  if (!allowedRoles.includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  setAuditContext(session.userId, req.headers.get('x-forwarded-for') || '', req.headers.get('user-agent') || '')

  const body = await req.json()
  const {
    name,
    phone,
    email,
    password,
    clinicIds, // array of clinic IDs, first is primary
    joinDate,
    // Pay rule config
    payType,
    baseAmount,
    configJson, // overtime rules etc.
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

  // Create User + Employee in a transaction
  const result = await prisma.$transaction(async (tx) => {
    // Create user
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

    // Create employee record
    const employeeData: any = {
      userId: user.id,
      joinDate: joinDate ? new Date(joinDate) : new Date(),
      status: 'ACTIVE',
    }

    // Create EmployeeClinic links
    const employeeClinicData = clinicIds.map((cid: string, idx: number) => ({
      clinic: { connect: { id: cid } },
      isPrimary: idx === 0,
    }))
    employeeData.clinics = { create: employeeClinicData }

    // Create initial pay rule if provided
    if (payType) {
      const payRuleData: any = {
        payType,
        baseAmount: baseAmount ?? null,
        configJson: configJson || null,
        effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
        createdBy: session.userId,
      }
      employeeData.payRules = { create: payRuleData }
    }

    const employee = await tx.employee.create({
      data: employeeData,
      include: {
        user: { select: { id: true, name: true, phone: true, email: true } },
        clinics: { include: { clinic: { select: { id: true, name: true } } } },
        payRules: true,
      },
    })

    // Audit log
    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'CREATE',
        entity: 'Employee',
        entityId: employee.id,
        afterJson: JSON.stringify(employee),
      },
    })

    return employee
  })

  return NextResponse.json({ success: true, employee: result }, { status: 201 })
}
