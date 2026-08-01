export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { toHKDateStr } from '@/lib/hk-date'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { buildDefaultPayConfig } from '@/lib/pay-rule-defaults'
import { jsonNoStore } from '@/lib/api-response'

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
        employee: { include: { payRules: { where: { isActive: true }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }], take: 1 } } },
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
      fullName: user.fullName,
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
      configJson: payRule?.configJson || null,
      homeClinicId: empHomeClinicMap.get(user.id) || null,
      permissionsJson: user.permissionsJson,
      clinics,
    }
  })

  return jsonNoStore({ accounts })
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
        fullName,
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
          fullName: fullName || null,
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
          const finalConfig = configJson
            || JSON.stringify(buildDefaultPayConfig(payType, baseAmount))
          empData.payRules = {
            create: {
              payType,
              baseAmount: baseAmount ?? null,
              configJson: finalConfig,
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

        // ★ 唔再喺建立帳號時人手設年假額度（2026-08-01 決定）。
        //   年假採累積制（year=0），由 totalAccruedLeave(joinDate, now, 'earned') 自動計算。
        //   舊版寫入 year=當前曆年 + 人手 entitled，同累積制並存兩個 row，
        //   而且按 name:'年假' 搵 LeaveType（唔係 systemKey）有機會建立重複類型。
        //   新員工嘅年假會喺下次 refresh 時自動建立；入職未滿試用期時本來就應該係 0。
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
