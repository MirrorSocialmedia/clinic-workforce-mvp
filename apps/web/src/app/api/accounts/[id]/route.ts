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
  const auth = requireAuth(req, 'GET', req.url)
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

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'PUT', req.url)
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
      const { name, phone, email, role, status, clinicIds, payType, baseAmount, configJson, effectiveFrom, employeeStatus, newPassword, assignEmployee, joinDate, payConfidential } = body

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
      let employee = existing.employee
      if (!employee && assignEmployee) {
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
      if (employee && (employeeStatus !== undefined || payType !== undefined || baseAmount !== undefined || payConfidential !== undefined)) {
        const empUpdate: any = {}
        if (employeeStatus !== undefined) empUpdate.status = employeeStatus
        if (payConfidential !== undefined) empUpdate.payConfidential = payConfidential

        await prisma.employee.update({
          where: { id: employee.id },
          data: empUpdate,
        })

        if (payType !== undefined) {
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

          await prisma.payRule.create({
            data: {
              employeeId: employee.id,
              payType,
              baseAmount: baseAmount ?? null,
              configJson: configJson || JSON.stringify(defaultModularConfig),
              effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
              createdBy: session.userId,
            },
          })
        }
      }

      await prisma.auditLog.create({
        data: {
          action: 'UPDATE_ACCOUNT',
          entity: 'ACCOUNT',
          entityId: params.id,
          actorId: session.userId,
          notes: JSON.stringify({ updated: body }),
        },
      })

      const updated = await prisma.user.findUnique({
        where: { id: params.id },
        include: { clinics: { include: { clinic: true } }, employee: { select: { id: true, payConfidential: true, joinDate: true, status: true, notes: true, leaveDate: true } } },
      })
      if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

      const { password, ...safeUser } = updated
      return NextResponse.json({ account: safeUser })
    } catch (err: any) {
      return NextResponse.json({ error: err.message || 'Failed to update' }, { status: 500 })
    }
  })
}
