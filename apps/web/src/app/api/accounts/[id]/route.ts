export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const user = await prisma.user.findUnique({
    where: { id: params.id },
    include: {
      clinics: { include: { clinic: true } },
      employee: {
        include: {
          clinics: { include: { clinic: true } },
          payRules: true,
        },
      },
    },
  })

  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { password, ...safeUser } = user
  return NextResponse.json({ account: safeUser })
}

// ============================================================
// DELETE /api/accounts/[id] — Hard delete account (OWNER only)
// Clean accounts: cascade delete in transaction
// Accounts with business records: rejected (use deactivation instead)
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  if (session.role !== 'OWNER') {
    return NextResponse.json({ error: '只有 OWNER 可以刪除帳號' }, { status: 403 })
  }

  if (session.userId === params.id) {
    return NextResponse.json({ error: '不能刪除自己的帳號' }, { status: 400 })
  }

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const user = await prisma.user.findUnique({
      where: { id: params.id },
      include: { employee: true },
    })

    if (!user) return NextResponse.json({ error: '帳號不存在' }, { status: 404 })

    const targetEmpId = user.employee?.id ?? null

    if (user.employee) {
      const empId = user.employee.id

      // Check business records
      const [punches, shifts, items, leaves] = await Promise.all([
        prisma.punchRecord.count({ where: { employeeId: empId } }),
        prisma.shift.count({ where: { employeeId: empId } }),
        prisma.payrollItem.count({ where: { employeeId: empId } }),
        prisma.leaveRequest.count({ where: { employeeId: empId } }),
      ])
      const total = punches + shifts + items + leaves

      if (total > 0) {
        return NextResponse.json({
          error: `此員工已有 ${total} 筆業務記錄（打卡${punches}/排班${shifts}/計糧${items}/假期${leaves}），不可刪除。請改為「停用」（保留歷史與審計）。`,
        }, { status: 400 })
      }

      // Clean account: cascade delete in transaction
      await prisma.$transaction([
        prisma.timeBankEntry.deleteMany({ where: { employeeId: empId } }),
        prisma.leaveBalance.deleteMany({ where: { employeeId: empId } }),
        prisma.employeeClinic.deleteMany({ where: { employeeId: empId } }),
        prisma.payRule.deleteMany({ where: { employeeId: empId } }),
        prisma.employee.delete({ where: { id: empId } }),
        prisma.user.delete({ where: { id: params.id } }),
      ])
    } else {
      await prisma.user.delete({ where: { id: params.id } })
    }

    await prisma.auditLog.create({
      data: {
        action: 'ACCOUNT_DELETE',
        entity: 'ACCOUNT',
        entityId: params.id,
        actorId: session.userId,
        ...(targetEmpId ? { targetEmployeeId: targetEmpId } : {}),
        notes: JSON.stringify({ name: user.name, email: user.email }),
      },
    })

    return NextResponse.json({ ok: true })
  })
}

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
    try {
      const body = await req.json()
      const { name, phone, email, role, status, clinicIds, payType, baseAmount, configJson, effectiveFrom, employeeStatus, newPassword, assignEmployee, joinDate, payConfidential, homeClinicId, permissionsJson, ipAllowlist } = body

      const existing = await prisma.user.findUnique({
        where: { id: params.id },
        include: { employee: true },
      })
      if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

      const userUpdate: any = {}
      if (name !== undefined) userUpdate.name = name
      if (phone !== undefined) userUpdate.phone = phone
      if (email !== undefined) userUpdate.email = email
      if (role !== undefined) userUpdate.role = role
      if (status !== undefined) userUpdate.status = status
      if (newPassword) {
        userUpdate.password = await bcrypt.hash(newPassword, 12)
        // Invalidate all existing sessions on password change
        userUpdate.tokenVersion = { increment: 1 }
      }
      if (status === 'INACTIVE' && existing.status !== 'INACTIVE') {
        // Invalidate all existing sessions on deactivation
        userUpdate.tokenVersion = { increment: 1 }
      }
      if (permissionsJson !== undefined) {
        userUpdate.permissionsJson = permissionsJson ? JSON.stringify(permissionsJson) : null
      }
      if (ipAllowlist !== undefined) {
        userUpdate.ipAllowlist = ipAllowlist || null
      }

      await prisma.user.update({
        where: { id: params.id },
        data: userUpdate,
      })

      // Update clinics
      if (clinicIds !== undefined) {
        await prisma.userClinic.deleteMany({ where: { userId: params.id } })
        if (clinicIds.length > 0) {
          await prisma.userClinic.createMany({
            data: clinicIds.map((cid: string, idx: number) => ({
              userId: params.id,
              clinicId: cid,
              isPrimary: idx === 0,
            })),
          })
        }
      }

      // ① Backfill employee record if assignEmployee is true but no employee exists
      // KIOSK accounts never get employee records
      let employee = existing.employee
      if (!employee && assignEmployee && role !== 'KIOSK') {
        employee = await prisma.employee.create({
          data: {
            userId: params.id,
            joinDate: joinDate ? new Date(joinDate) : new Date(),
            status: 'ACTIVE',
          },
        })
      }

      // ② Sync EmployeeClinic (scheduling reads from EmployeeClinic, not UserClinic)
      if (clinicIds !== undefined && employee) {
        await prisma.employeeClinic.deleteMany({ where: { employeeId: employee.id } })
        if (clinicIds.length > 0) {
          await prisma.employeeClinic.createMany({
            data: clinicIds.map((cid: string, idx: number) => ({
              employeeId: employee.id,
              clinicId: cid,
              isPrimary: idx === 0,
            })),
          })
        }
      }

      // Update employee if exists (may have just been backfilled above)
      let homeClinicCleared = false
      if (employee && (employeeStatus !== undefined || payType !== undefined || baseAmount !== undefined || payConfidential !== undefined || homeClinicId !== undefined)) {
        const empUpdate: any = {}
        if (employeeStatus !== undefined) empUpdate.status = employeeStatus
        if (payConfidential !== undefined) empUpdate.payConfidential = payConfidential
        if (homeClinicId !== undefined) {
          if (homeClinicId === '' || homeClinicId === null) {
            empUpdate.homeClinicId = null
          } else if (clinicIds && clinicIds.includes(homeClinicId)) {
            empUpdate.homeClinicId = homeClinicId
          } else {
            return NextResponse.json({ error: '長駐店不在已指派診所中，請確認診所指派後重試' }, { status: 400 })
          }
        } else if (clinicIds && employee?.homeClinicId && !clinicIds.includes(employee.homeClinicId)) {
          // homeClinicId 沒被提交但舊值不在新 clinicIds 中 → 自動清空
          empUpdate.homeClinicId = null
          homeClinicCleared = true
        }

        await prisma.employee.update({
          where: { id: employee.id },
          data: empUpdate,
        })

        if (payType !== undefined) {
          const effDate = effectiveFrom ? new Date(effectiveFrom) : new Date()

          // ① 檢查是否真的有變更——無變更就不建新規則（防連按兩次）
          const current = await prisma.payRule.findFirst({
            where: { employeeId: employee.id, isActive: true },
            orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
          })
          const incomingConfig = configJson || (current?.configJson ?? JSON.stringify({
            base_type: payType === 'MONTHLY' ? 'monthly' : 'hourly',
            ...(payType === 'MONTHLY' ? { monthly_salary: baseAmount ?? 50000 } : { hourly_rate: baseAmount ?? 180 }),
            modifiers: {
              working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
              deduction: { basis: 'statutory' },
              mpf: { enabled: true, rate: 0.05, min: 7100, max: 30000 },
            },
          }))
          const unchanged = current
            && current.payType === payType
            && current.baseAmount === (baseAmount ?? null)
            && current.configJson === incomingConfig

          if (!unchanged) {
            // ② 關閉所有舊 active 規則（防多筆 active）
            await prisma.payRule.updateMany({
              where: { employeeId: employee.id, isActive: true },
              data: { isActive: false, effectiveTo: new Date(effDate.getTime() - 86400000) },
            })

            // ③ 創建新規則——configJson 缺失時繼承現有，不用殘缺預設覆蓋
            const newRule = await prisma.payRule.create({
              data: {
                employeeId: employee.id,
                payType,
                baseAmount: baseAmount ?? null,
                configJson: incomingConfig,
                effectiveFrom: effDate,
                createdBy: session.userId,
              },
            })

            // 審計記錄 PayRule 變更
            await prisma.auditLog.create({
              data: {
                actorId: session.userId,
                action: 'PAY_RULE_UPDATE_VIA_ACCOUNTS',
                entity: 'PayRule',
                entityId: newRule.id,
                targetEmployeeId: employee.id,
                afterJson: JSON.stringify({ payType, baseAmount, configJson: incomingConfig, effectiveFrom: effDate }),
              } as any,
            })
          }
        }
      }

      await prisma.auditLog.create({
        data: {
          action: 'UPDATE_ACCOUNT',
          entity: 'ACCOUNT',
          entityId: params.id,
          actorId: session.userId,
          ...(employee ? { targetEmployeeId: employee.id } : {}),
          notes: JSON.stringify({ updated: body }),
        },
      })

      const updated = await prisma.user.findUnique({
        where: { id: params.id },
        include: { clinics: { include: { clinic: true } }, employee: { select: { id: true, payConfidential: true, joinDate: true, status: true, notes: true, leaveDate: true } } },
      })
      if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

      const { password, ...safeUser } = updated
      return NextResponse.json({
        account: safeUser,
        ...(homeClinicCleared ? { note: '長駐店已自動清空（已取消該診所指派）' } : {}),
      })
    } catch (err: any) {
      return NextResponse.json({ error: err.message || 'Failed to update' }, { status: 500 })
    }
  })
}
