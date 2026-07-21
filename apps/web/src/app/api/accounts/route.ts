export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { toHKDateStr } from '@/lib/hk-date'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/accounts — merged User + Employee list
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const role = searchParams.get('role')
  const status = searchParams.get('status')
  const search = searchParams.get('search')
  const includeResigned = searchParams.get('includeResigned') === 'true'

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
  // Default: exclude RESIGNED employees unless explicitly requested
  if (!includeResigned) {
    empWhere.status = { not: 'RESIGNED' }
  }

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
  // Build employeeId → homeClinicId mapping
  const empHomeClinicMap = new Map(allEmployees.map(e => [e.userId, e.homeClinicId || null]))

  const safeUsers = users.map(({ password, ...user }) => user)

  // Filter out users with RESIGNED employee status unless includeResigned
  const filteredUsers = includeResigned
    ? safeUsers
    : safeUsers.filter(u => !u.employee || u.employee.status !== 'RESIGNED')

  const accounts = filteredUsers.map(user => {
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
      resignedAt: emp?.resignedAt ? emp.resignedAt.toISOString() : null,
      payConfidential: emp?.payConfidential || false,
      joinDate: emp?.joinDate ? toHKDateStr(new Date(emp.joinDate)) : null,
      payType: payRule?.payType || null,
      baseAmount: payRule?.baseAmount || null,
      homeClinicId: empHomeClinicMap.get(user.id) || null,
      clinics,
    }
  })

  return NextResponse.json({ accounts })
}

// POST /api/accounts — create user + optionally employee
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
      const {
        name, phone, email, password, role, clinicIds,
        joinDate, payType, baseAmount, configJson, effectiveFrom,
        assignEmployee = false,
        annualLeave,
        payConfidential = false,
        homeClinicId,
        permissionsJson,
        ipAllowlist,
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
          permissionsJson: permissionsJson ? JSON.stringify(permissionsJson) : null,
          ipAllowlist: ipAllowlist || null,
        },
        include: { clinics: { include: { clinic: true } } },
      })

      let employee = null
      // KIOSK accounts never create employee records
      const shouldCreateEmployee = assignEmployee && role !== 'KIOSK'
      if (shouldCreateEmployee) {
        // Validate homeClinicId: must be within assigned clinics
        if (homeClinicId && !clinicIds?.includes(homeClinicId)) {
          return NextResponse.json({ error: '長駐店不在已指派診所中，請確認診所指派後重試' }, { status: 400 })
        }

        const empClinicData = clinicIds && clinicIds.length > 0
          ? { create: clinicIds.map((cid: string, idx: number) => ({ clinic: { connect: { id: cid } }, isPrimary: idx === 0 })) }
          : undefined

        const empData: any = {
          userId: user.id,
          joinDate: joinDate ? new Date(joinDate) : new Date(),
          status: 'ACTIVE',
          payConfidential,
          clinics: empClinicData,
          homeClinicId: homeClinicId || null,
        }

        if (payType) {
          // 如果前端沒送 configJson，自動生成新格式 modularConfig
          const defaultModularConfig = {
            base_type: payType === 'MONTHLY' ? 'monthly' : 'hourly',
            ...(payType === 'MONTHLY' ? { monthly_salary: baseAmount ?? 50000 } : { hourly_rate: baseAmount ?? 180 }),
            modifiers: {
              working_days: {
                basis: 'scheduled',
                rest_days: [6, 0], // 週六日為休息日
                count_public_holidays: true,
              },
              deduction: { basis: 'statutory' },
              mpf: { enabled: true, rate: 0.05, min: 7100, max: 30000 },
            },
          }

          empData.payRules = {
            create: {
              payType,
              baseAmount: baseAmount ?? null,
              configJson: configJson || JSON.stringify(defaultModularConfig),
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

        // Create initial leave balances for the new employee
        const currentYear = new Date().getUTCFullYear()
        if (annualLeave || annualLeave === 0) {
          // Get or create leave types using findFirst + create
          let annualType = await prisma.leaveType.findFirst({ where: { name: '年假' } })

          if (!annualType) {
            annualType = await prisma.leaveType.create({
              data: { name: '年假', isPaid: true, annualQuota: annualLeave || 12, color: '#2196F3' },
            })
          }

          const leaveBalanceData = []
          if (annualLeave != null) {
            leaveBalanceData.push({
              employeeId: employee.id,
              leaveTypeId: annualType.id,
              year: currentYear,
              entitled: annualLeave,
              remaining: annualLeave,
            })
          }

          if (leaveBalanceData.length > 0) {
            await prisma.leaveBalance.createMany({ data: leaveBalanceData })
          }
        }
      }

      const auditAction = assignEmployee ? 'CREATE_ACCOUNT_WITH_EMPLOYEE' : 'CREATE_ACCOUNT'
      await prisma.auditLog.create({
        data: {
          action: auditAction,
          entity: 'ACCOUNT',
          entityId: user.id,
          actorId: session.userId,
          ...(assignEmployee && employee ? { targetEmployeeId: employee.id } : {}),
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
