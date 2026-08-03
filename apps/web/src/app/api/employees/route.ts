export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { buildDefaultPayConfig } from '@/lib/pay-rule-defaults'

// ============================================================
// GET /api/employees — list employees with filters
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope, perms } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const role = searchParams.get('role')
  const status = searchParams.get('status')
  const search = searchParams.get('search')
  const includeResigned = searchParams.get('includeResigned') === 'true'
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  const pageSize = Math.min(200, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10) || 20))
  const skip = (page - 1) * pageSize

  // ★ 下拉選單需要全部員工 —— 分頁預設 20 會靜靜漏人（2026-08-03 撞過）。
  // all=1 唔分頁，但只可以用喺內部管理頁（員工數目可控）。
  const takeAll = searchParams.get('all') === '1'

  const where: any = {}

  // Default: exclude RESIGNED employees unless explicitly requested
  if (!includeResigned) {
    where.status = { not: 'RESIGNED' }
  }

  if (clinicId) {
    where.clinics = { some: { clinicId } }
  }

  // Merge status filter with resigned exclusion
  if (status) {
    if (includeResigned) {
      where.status = status
    } else {
      where.status = status === 'RESIGNED' ? 'RESIGNED' : { not: 'RESIGNED' }
    }
  } else if (!includeResigned) {
    // Ensure not-RESIGNED is set (already set above, but be explicit)
    where.status = { not: 'RESIGNED' }
  }

  if (search) {
    where.user = {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ],
    }
  }

  // ★ 保密員工隔離參數（員工總覽用）——
  //   預設 false，唔傳參數時行為不變（排班等 caller 唔受影響）
  //   排班需要見到全部員工（保密只係薪金，唔影響排更）
  const excludeConfidential = searchParams.get('excludeConfidential') === '1'
  if (excludeConfidential && session.role !== 'OWNER') { // ROLE-OK: 保密員工隔離，刻意用 role 唔用權限
    where.payConfidential = false
  }

  // ★ employee_overview 只睇主屬診所（2026-08-03）
  const scopeToHome = searchParams.get('scopeToHome') === '1'
  if (scopeToHome) {
    const allowed = await resolveClinicScope(session, perms ?? [])
    if (allowed !== null && allowed.length > 0) {
      where.homeClinicId = { in: allowed }
    }
  }

  // ★ MANAGER 睇到全公司員工係刻意嘅（2026-08-03 決定）——
  //   排班需要跨店調人（調鋪／借調），限制成自己診所會令排班做唔到。
  //   員工總覽頁有診所篩選，唔方便嘅問題由 UI 解決而唔係限制資料。
  const canSeeAllEmployees = scope === 'all' || (perms ?? []).includes('scheduling')

  if (!canSeeAllEmployees) {
    where.user = {
      ...(where.user || {}),
      clinics: { some: { clinicId: { in: session.clinics ?? [] } } },
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
        homeClinic: { select: { id: true, name: true } },
        payRules: {
          where: { isActive: true },
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
          take: 1,
          select: { payType: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: takeAll ? 0 : skip,
      take: takeAll ? 500 : pageSize,
    }),
    prisma.employee.count({ where }),
  ])

  return NextResponse.json(
    { employees, total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  )
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
              configJson: configJson || JSON.stringify(buildDefaultPayConfig(payType, baseAmount)),
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
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const target = String(error?.meta?.target ?? '')
        if (target.includes('payrule')) {
          return NextResponse.json(
            { error: '薪資規則正在更新中，請重新整理後再試' }, { status: 409 })
        }
        if (target.includes('phone')) {
          return NextResponse.json({ error: '此電話號碼已被使用' }, { status: 409 })
        }
        console.error('P2002 unexpected target:', error?.meta)
        return NextResponse.json({ error: '資料重複，請檢查輸入' }, { status: 409 })
      }
      console.error('Create employee error:', error)
      return NextResponse.json({ error: '建立員工失敗', details: String(error?.message) }, { status: 500 })
    }
  })
}
