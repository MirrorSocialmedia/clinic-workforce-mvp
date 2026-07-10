export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'

// GET /api/employees/:id/pay-rules — get all pay rules for employee
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const payRules = await prisma.payRule.findMany({
    where: { employeeId: params.id },
    orderBy: { effectiveFrom: 'desc' },
  })

  // Parse configJson string → modularConfig object
  const rulesWithConfig = payRules.map(r => ({
    ...r,
    configJson: r.configJson ? JSON.parse(r.configJson) : null,
  }))

  return NextResponse.json(rulesWithConfig)
}

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
    const { payType, baseAmount, configJson, effectiveFrom, modularConfig } = body

    if (!payType || !effectiveFrom) {
      return NextResponse.json({ error: 'payType and effectiveFrom are required' }, { status: 400 })
    }

    // Support new modular config format
    const finalConfigJson = modularConfig
      ? JSON.stringify(modularConfig)
      : configJson || null

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
          configJson: finalConfigJson,
          effectiveFrom: effectiveDate,
          createdBy: session.userId,
          isActive: true,
        },
      })

      return rule
    })

    return NextResponse.json({ success: true, payRule }, { status: 201 })
  })
}
