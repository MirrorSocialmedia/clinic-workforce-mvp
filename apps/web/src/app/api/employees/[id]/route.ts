import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { verifyToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { prisma } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// ============================================================
// GET /api/employees/[id] — employee detail
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const allowedRoles = ['OWNER', 'MANAGER', 'ACCOUNTANT']
  if (!allowedRoles.includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const employee = await prisma.employee.findUnique({
    where: { id: params.id },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          role: true,
          createdAt: true,
        },
      },
      clinics: {
        include: { clinic: { select: { id: true, name: true } } },
        orderBy: [{ isPrimary: 'desc' }, { joinedAt: 'asc' }],
      },
      payRules: {
        orderBy: { effectiveFrom: 'desc' },
      },
      shifts: {
        orderBy: { date: 'desc' },
        take: 10,
        include: { clinic: { select: { id: true, name: true } } },
      },
    },
  })

  if (!employee) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 })
  }

  // For non-OWNER, check clinic access
  if (session.role !== 'OWNER') {
    const hasAccess = employee.clinics.some(
      (ec) => session.clinics.includes(ec.clinic.id)
    )
    if (!hasAccess) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  return NextResponse.json({ employee })
}

// ============================================================
// PUT /api/employees/[id] — edit employee
// Roles: OWNER, MANAGER
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const allowedRoles = ['OWNER', 'MANAGER']
  if (!allowedRoles.includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  const body = await req.json()
  const {
    name,
    phone,
    email,
    password,
    clinicIds, // array of clinic IDs, first is primary
    joinDate,
    status,
    notes,
  } = body

  const employee = await prisma.employee.findUnique({
    where: { id: params.id },
    include: { user: true },
  })

  if (!employee) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 })
  }

  // Build update data
  const beforeJson = JSON.stringify(employee)

  const userUpdateData: any = {}
  if (name) userUpdateData.name = name
  if (email !== undefined) userUpdateData.email = email
  if (password) userUpdateData.password = await bcrypt.hash(password, 12)

  // Phone change with uniqueness check
  if (phone && phone !== employee.user.phone) {
    const existing = await prisma.user.findUnique({ where: { phone } })
    if (existing) {
      return NextResponse.json(
        { error: 'Phone already registered' },
        { status: 409 }
      )
    }
    userUpdateData.phone = phone
  }

  // Update user clinics if changed
  if (clinicIds) {
    // We handle this in transaction
    userUpdateData.clinics = {
      deleteMany: {},
      create: clinicIds.map((cid: string, idx: number) => ({
        clinic: { connect: { id: cid } },
        isPrimary: idx === 0,
      })),
    }
  }

  // Build employee update data
  const employeeUpdateData: any = {}
  if (joinDate) employeeUpdateData.joinDate = new Date(joinDate)
  if (status) employeeUpdateData.status = status
  if (notes !== undefined) employeeUpdateData.notes = notes

  if (status === 'RESIGNED' && !employee.leaveDate) {
    employeeUpdateData.leaveDate = new Date()
  }

  const result = await prisma.$transaction(async (tx) => {
    // Update user
    if (Object.keys(userUpdateData).length > 0) {
      await tx.user.update({
        where: { id: employee.userId },
        data: userUpdateData,
      })
    }

    // Update employee clinics if changed
    if (clinicIds) {
      await tx.employeeClinic.deleteMany({ where: { employeeId: employee.id } })
      await tx.employeeClinic.createMany({
        data: clinicIds.map((cid: string, idx: number) => ({
          employeeId: employee.id,
          clinicId: cid,
          isPrimary: idx === 0,
        })),
      })
    }

    // Update employee
    const updated = await tx.employee.update({
      where: { id: employee.id },
      data: employeeUpdateData,
      include: {
        user: { select: { id: true, name: true, phone: true, email: true } },
        clinics: {
          include: { clinic: { select: { id: true, name: true } } },
        },
      },
    })

    // Audit log
    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'UPDATE',
        entity: 'Employee',
        entityId: employee.id,
        beforeJson,
        afterJson: JSON.stringify(updated),
      },
    })

    return updated
  })

  return NextResponse.json({ success: true, employee: result })
}
