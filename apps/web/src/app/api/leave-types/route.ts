import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/leave-types — List leave types
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET() {
  const types = await prisma.leaveType.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json({ leaveTypes: types })
}

// ============================================================
// POST /api/leave-types — Create leave type
// Roles: OWNER
// ============================================================
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
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
      const { name, isPaid, annualQuota, color } = body

      if (!name) {
        return NextResponse.json({ error: 'name is required' }, { status: 400 })
      }

      const existing = await prisma.leaveType.findFirst({
        where: { name, isActive: true },
      })
      if (existing) {
        return NextResponse.json({ error: `Leave type "${name}" already exists` }, { status: 400 })
      }

      const leaveType = await prisma.leaveType.create({
        data: {
          name,
          isPaid: isPaid !== undefined ? isPaid : true,
          annualQuota: annualQuota ?? null,
          color: color ?? null,
        },
      })

      await prisma.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'CREATE',
          entity: 'LeaveType',
          entityId: leaveType.id,
          notes: `Created leave type: ${name}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })

      return NextResponse.json({ success: true, leaveType }, { status: 201 })
    } catch (error) {
      console.error('Leave type create error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
