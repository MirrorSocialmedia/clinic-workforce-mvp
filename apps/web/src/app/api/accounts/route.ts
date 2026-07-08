export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/accounts — merged User + Employee list
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const role = searchParams.get('role')
  const status = searchParams.get('status')
  const search = searchParams.get('search')

  const userWhere: any = {}
  if (role) userWhere.role = role
  if (status) userWhere.status = status
  if (search) {
    userWhere.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
    ]
  }

  const empWhere: any = {}
  if (clinicId) empWhere.clinics = { some: { clinicId } }
  if (search) {
    empWhere.user = {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ],
    }
  }

  const [users, allEmployees] = await Promise.all([
    prisma.user.findMany({
      where: userWhere,
      include: {
        clinics: { include: { clinic: true } },
        employee: { include: { payRules: { where: { isActive: true }, orderBy: { effectiveFrom: 'desc' }, take: 1 } } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.employee.findMany({
      include: { clinics: { include: { clinic: true } } },
    }),
  ])

  // Build employeeId → clinics mapping from EmployeeClinic
  const empClinicsMap = new Map(allEmployees.map(e => [e.userId, e.clinics.map(c => c.clinic)]))

  const safeUsers = users.map(({ password, ...user }) => user)
  const accounts = safeUsers.map(user => {
    const emp = user.employee || null
    const payRule = emp?.payRules?.[0] || null
    // 優先使用 EmployeeClinic，其次 UserClinic
    const clinics = empClinicsMap.get(user.id) || user.clinics.map((uc: any) => uc.clinic)
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      employeeId: emp?.id || null,
      employeeStatus: emp?.status || null,
      joinDate: emp?.joinDate?.toISOString().slice(0, 10) || null,
      payType: payRule?.payType || null,
      baseAmount: payRule?.baseAmount || null,
      clinics,
    }
  })

  return NextResponse.json({ accounts })
}

// POST /api/accounts — create user + optionally employee
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const {
        name, phone, email, password, role, clinicIds,
        joinDate, payType, baseAmount, configJson, effectiveFrom,
        assignEmployee = false,
      } = await req.json()

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

      const user = await prisma.user.create({
        data: {
          name, phone, email: email || null,
          password: hashedPassword,
          role: role as any,
          status: 'ACTIVE',
          clinics: clinicData,
        },
        include: { clinics: { include: { clinic: true } } },
      })

      let employee = null
      if (assignEmployee) {
        const empClinicData = clinicIds && clinicIds.length > 0
          ? { create: clinicIds.map((cid: string, idx: number) => ({ clinic: { connect: { id: cid } }, isPrimary: idx === 0 })) }
          : undefined

        const empData: any = {
          userId: user.id,
          joinDate: joinDate ? new Date(joinDate) : new Date(),
          status: 'ACTIVE',
          clinics: empClinicData,
        }

        if (payType) {
          empData.payRules = {
            create: {
              payType,
              baseAmount: baseAmount ?? null,
              configJson: configJson || null,
              effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
              createdBy: session.userId,
            },
          }
        }

        employee = await prisma.employee.create({
          data: empData,
          include: {
            user: { select: { id: true, name: true, phone: true } },
            clinics: { include: { clinic: true } },
          },
        })
      }

      const auditAction = assignEmployee ? 'CREATE_ACCOUNT_WITH_EMPLOYEE' : 'CREATE_ACCOUNT'
      await prisma.auditLog.create({
        data: {
          action: auditAction,
          entity: 'ACCOUNT',
          entityId: user.id,
          actorId: session.userId,
          notes: JSON.stringify({ name, phone, role, assignEmployee }),
        },
      })

      const safeUser = { ...user, password: undefined }
      return NextResponse.json({ account: safeUser, employee })
    } catch (err: any) {
      console.error('Create account error:', err)
      return NextResponse.json({ error: err.message || 'Failed to create account' }, { status: 500 })
    }
  })
}
