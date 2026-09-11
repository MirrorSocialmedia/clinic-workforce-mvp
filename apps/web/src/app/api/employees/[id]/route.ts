export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { jsonNoStore } from '@/lib/api-response'
import { hkDateOnly, hkTodayStr, addDaysStr } from '@/lib/hk-date'

// GET /api/employees/[id] — employee detail
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const employee = await prisma.employee.findUnique({
    where: { id: params.id },
    include: {
      user: {
        select: { id: true, name: true, phone: true, email: true, role: true, createdAt: true },
      },
      clinics: {
        include: { clinic: { select: { id: true, name: true } } },
        orderBy: [{ isPrimary: 'desc' }, { joinedAt: 'asc' }],
      },
      payRules: { orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] },
      shifts: {
        orderBy: { date: 'desc' },
        take: 10,
        include: { clinic: { select: { id: true, name: true } } },
      },
    },
  })

  if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  // For managers, check clinic access
  if (scope === 'my-clinics') {
    const sessionClinics = session.clinics ?? []
    const hasAccess = employee.clinics.some(
      (ec: any) => sessionClinics.includes(ec.clinic.id)
    )
    if (!hasAccess) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return jsonNoStore({ employee })
}

// PUT /api/employees/[id] — edit employee
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const body = await req.json()
    const { name, phone, email, password, clinicIds, joinDate, status, notes } = body

    const employee = await prisma.employee.findUnique({
      where: { id: params.id },
      include: { user: true },
    })

    if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

    const beforeJson = JSON.stringify(employee)

    const userUpdateData: any = {}
    if (name) userUpdateData.name = name
    if (email !== undefined) userUpdateData.email = email
    if (password) userUpdateData.password = await bcrypt.hash(password, 12)

    if (phone && phone !== employee.user.phone) {
      const existing = await prisma.user.findUnique({ where: { phone } })
      if (existing) return NextResponse.json({ error: 'Phone already registered' }, { status: 409 })
      userUpdateData.phone = phone
    }

    const employeeUpdateData: any = {}
    if (joinDate) employeeUpdateData.joinDate = hkDateOnly(joinDate)
    if (status) employeeUpdateData.status = status
    if (notes !== undefined) employeeUpdateData.notes = notes
    // ★ cwm-resignflow-20260911 E1：同 resign-settle 寫同一組欄，否則兩條路數據形狀唔同。
    //   剷咗 `&& !employee.leaveDate` — 呢個條件令「改最後工作日」永遠唔生效（第一次寫咗就再唔會更新）。
    //   lastDay 由 body 收（前端 prompt）；冇傳就當今日（後備路徑，冇結算）。
    if (status === 'RESIGNED') {
      const lastDayStr = typeof body.lastDay === 'string' && body.lastDay ? body.lastDay : hkTodayStr()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDayStr)) {
        return NextResponse.json({ error: 'lastDay 必須係 YYYY-MM-DD' }, { status: 400 })
      }
      employeeUpdateData.leaveDate = hkDateOnly(lastDayStr)                    // 最後工作日
      employeeUpdateData.resignedAt = hkDateOnly(addDaysStr(lastDayStr, 1))    // 生效日 = +1（語義寫死）
      userUpdateData.status = 'RESIGNED'   // ★★★ 停用帳號（login:71 驗 User.status）
    }

    const result = await prisma.$transaction(async (tx) => {
      if (Object.keys(userUpdateData).length > 0) {
        await tx.user.update({
          where: { id: employee.userId },
          data: userUpdateData,
        })
      }

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

      const updated = await tx.employee.update({
        where: { id: employee.id },
        data: employeeUpdateData,
        include: {
          user: { select: { id: true, name: true, phone: true, email: true } },
          clinics: { include: { clinic: { select: { id: true, name: true } } } },
        },
      })

      return updated
    })

    return NextResponse.json({ success: true, employee: result })
  })
}
