export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma, createAuditLog } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

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
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!['OWNER'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

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

    await createAuditLog({
      action: 'CREATE',
      entity: 'LeaveType',
      entityId: leaveType.id,
      notes: `Created leave type: ${name}`,
    })

    return NextResponse.json({ success: true, leaveType }, { status: 201 })
  } catch (error) {
    console.error('Leave type create error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
