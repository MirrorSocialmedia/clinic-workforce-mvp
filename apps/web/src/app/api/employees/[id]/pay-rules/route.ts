import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// ============================================================
// POST /api/employees/:id/pay-rules — add new pay rule
// Roles: OWNER
// ============================================================
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Forbidden: OWNER only' }, { status: 403 })
  }

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  const body = await req.json()
  const { payType, baseAmount, configJson, effectiveFrom } = body

  if (!payType || !effectiveFrom) {
    return NextResponse.json(
      { error: 'payType and effectiveFrom are required' },
      { status: 400 }
    )
  }

  const employee = await prisma.employee.findUnique({ where: { id: params.id } })
  if (!employee) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 })
  }

  const effectiveDate = new Date(effectiveFrom)

  const result = await prisma.$transaction(async (tx) => {
    // Deactivate current active pay rules for this employee
    // Set effectiveTo to the day before the new rule starts
    const deactivated = await tx.payRule.updateMany({
      where: {
        employeeId: employee.id,
        isActive: true,
        effectiveFrom: { lte: effectiveDate },
      },
      data: {
        isActive: false,
        effectiveTo: new Date(
          effectiveDate.getTime() - 86400000 // one day before
        ),
      },
    })

    // Create new pay rule
    const payRule = await tx.payRule.create({
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

    // Audit log
    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'CREATE',
        entity: 'PayRule',
        entityId: payRule.id,
        notes: `Added pay rule for employee ${employee.id}. Deactivated ${deactivated.count} existing rule(s).`,
        afterJson: JSON.stringify(payRule),
      },
    })

    return payRule
  })

  return NextResponse.json({ success: true, payRule: result }, { status: 201 })
}
