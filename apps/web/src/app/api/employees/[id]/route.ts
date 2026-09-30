export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { jsonNoStore } from '@/lib/api-response'
import { canSeeConfidential } from '@/lib/scope-helpers'
import { hkDateOnly, hkTodayStr, toHKDateStr } from '@/lib/hk-date'
import { applyResignCutoff } from '@/lib/resign-cutoff'

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

  // ★ cwm-p0sec-20260917：保密員工 —— 無權者 payRules 回空陣列（唔係 403，前端详情頁唔會報錯）
  const canSeePay = await canSeeConfidential(session, auth.perms ?? [], employee)
  if (!canSeePay) {
    // ★ cwm-p0sec-20260917 b2-fix：照原回應 shape 包 { employee }（前端 setEmployee(data.employee)）
    return jsonNoStore({ employee: { ...employee, payRules: [] } })
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
    const { name, phone, email, password, clinicIds, joinDate, status, notes, attendanceExempt } = body

    const employee = await prisma.employee.findUnique({
      where: { id: params.id },
      include: { user: true },
    })

    if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

    // ★ cwm-p0sec-20260917：非 OWNER 只可以改 EMPLOYEE 角色嘅帳號（防經理改其他經理／老闆密碼）
    if (session.role !== 'OWNER' && employee.user.role !== 'EMPLOYEE') { // ROLE-OK: 帳號安全邊界
      return NextResponse.json({ error: '唔可以修改管理層帳號，請搵負責人' }, { status: 403 })
    }

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
    // ★ cwm-attexempt-20260914 F：免考勤開關（會計等）—— 只影響考勤路徑，計糧/MPF/年假照常
    if (attendanceExempt !== undefined) employeeUpdateData.attendanceExempt = !!attendanceExempt
    // ★ cwm-resignflow-20260911 E1：標記離職同 resign-settle 寫同一組欄（兩條路數據形狀唔可走樣）。
    // ★ 2026-09-30 [cwm-restdebt] F2：改行共用 applyResignCutoff（RS-21）—— leaveDate/resignedAt、
    //   User RESIGNED + tokenVersion+1、取消之後更／假 + 還額、跨日假截斷、停人臉模板，三條路同一口徑。
    //   lastDay 由 body 收（前端 prompt）；冇傳就當今日（後備路徑，冇結算）。
    let resignLastDay: string | null = null
    if (status === 'RESIGNED') {
      const lastDayStr = typeof body.lastDay === 'string' && body.lastDay ? body.lastDay : hkTodayStr()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDayStr)) {
        return NextResponse.json({ error: 'lastDay 必須係 YYYY-MM-DD' }, { status: 400 })
      }
      // ★ 2026-09-30 [cwm-restdebt] F5（RS-09/18）：最後工作日未到唔准停帳號（同 /resign 同一口徑）
      if (lastDayStr > hkTodayStr()) {
        return NextResponse.json(
          { error: `最後工作日 ${lastDayStr} 未到，請喺當日或之後先辦理（期間員工要照常打卡）` },
          { status: 400 },
        )
      }
      if (employee.joinDate && lastDayStr < toHKDateStr(employee.joinDate)) {
        return NextResponse.json({ error: '最後工作日早過入職日' }, { status: 400 })
      }
      resignLastDay = lastDayStr
    }

    const result = await prisma.$transaction(async (tx) => {
      // ★ 2026-09-30 [cwm-restdebt] F2：標記離職 → 共用 cutoff（E-11 lockEmployee 喺函數內，先於其他寫入）
      if (resignLastDay) await applyResignCutoff(tx, employee.id, resignLastDay)

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

      // ★ cwm-p0sec-20260917 S2：User 喺 MANUAL_TXN_ENTITIES，audit extension 唔會記 → 手動補記
      //   任何 user/employee 欄改動（電話／密碼／狀態／attendanceExempt 等）都記；afterJson mask password
      if (Object.keys(userUpdateData).length > 0 || Object.keys(employeeUpdateData).length > 0) {
        await tx.auditLog.create({
          data: {
            actorId: session.userId,
            action: 'EMPLOYEE_ACCOUNT_UPDATE',
            entity: 'User',
            entityId: employee.userId,
            targetEmployeeId: employee.id,
            beforeJson: JSON.stringify({ name: employee.user.name, phone: employee.user.phone, email: employee.user.email, status: employee.user.status }),
            afterJson: JSON.stringify({ ...userUpdateData, ...employeeUpdateData, password: userUpdateData.password ? '[已更改]' : undefined }),
            ipAddress: req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || null,
            userAgent: req.headers.get('user-agent') || null,
          },
        })
      }

      return updated
    })

    return NextResponse.json({ success: true, employee: result })
  })
}
