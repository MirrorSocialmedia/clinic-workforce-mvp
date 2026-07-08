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
      const { name, phone, email, role, status, clinicIds, payType, baseAmount, configJson, effectiveFrom, employeeStatus, newPassword } = body

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

      // Update employee if exists
      if (existing.employee && (employeeStatus !== undefined || payType !== undefined || baseAmount !== undefined)) {
        const empUpdate: any = {}
        if (employeeStatus !== undefined) empUpdate.status = employeeStatus

        await prisma.employee.update({
          where: { id: existing.employee.id },
          data: empUpdate,
        })

        if (payType !== undefined) {
          await prisma.payRule.create({
            data: {
              employeeId: existing.employee.id,
              payType,
              baseAmount: baseAmount ?? null,
              configJson: configJson || null,
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
        include: { clinics: { include: { clinic: true } }, employee: true },
      })
      if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

      const { password, ...safeUser } = updated
      return NextResponse.json({ account: safeUser })
    } catch (err: any) {
      return NextResponse.json({ error: err.message || 'Failed to update' }, { status: 500 })
    }
  })
}
