import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'

// POST /api/employees/:id/pay-rules — add new pay rule
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const body = await req.json()
    const { payType, baseAmount, configJson, effectiveFrom } = body

    if (!payType || !effectiveFrom) {
      return NextResponse.json({ error: 'payType and effectiveFrom are required' }, { status: 400 })
    }

    const employee = await prisma.employee.findUnique({ where: { id: params.id } })
    if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

    const effectiveDate = new Date(effectiveFrom)

    const payRule = await prisma.$transaction(async (tx) => {
      const deactivated = await tx.payRule.updateMany({
        where: {
          employeeId: employee.id,
          isActive: true,
          effectiveFrom: { lte: effectiveDate },
        },
        data: {
          isActive: false,
          effectiveTo: new Date(effectiveDate.getTime() - 86400000),
        },
      })

      const rule = await tx.payRule.create({
        data: {
          employeeId: employee.id,
          payType,
          baseAmount: baseAmount ?? null,
          configJson: configJson || null,
          effectiveFrom: effectiveDate,
          createdBy: session.userId,
          isActive: true,
        },
      })

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'CREATE',
          entity: 'PayRule',
          entityId: rule.id,
          notes: `Added pay rule for employee ${employee.id}. Deactivated ${deactivated.count} existing rule(s).`,
          afterJson: JSON.stringify(rule),
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })

      return rule
    })

    return NextResponse.json({ success: true, payRule }, { status: 201 })
  })
}
