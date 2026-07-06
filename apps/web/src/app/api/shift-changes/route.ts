export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { prisma } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// ============================================================
// POST /api/shift-changes — create shift change request
// Roles: OWNER, MANAGER, EMPLOYEE
// ============================================================
export async function POST(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!['OWNER', 'MANAGER', 'EMPLOYEE'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  try {
    const body = await req.json()
    const { shiftId, toEmployeeId, type, reason } = body

    if (!shiftId || !type || !['SWAP', 'COVER', 'REPORT'].includes(type)) {
      return NextResponse.json(
        { error: 'shiftId and valid type (SWAP/COVER/REPORT) are required' },
        { status: 400 }
      )
    }

    // Get current user's employee record
    const fromEmp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })

    if (!fromEmp) {
      return NextResponse.json(
        { error: 'No employee record found' },
        { status: 404 }
      )
    }

    // Verify the shift exists and belongs to the employee (unless OWNER/MANAGER)
    const shift = await prisma.shift.findUnique({ where: { id: shiftId } })
    if (!shift) {
      return NextResponse.json({ error: 'Shift not found' }, { status: 404 })
    }

    if (session.role === 'EMPLOYEE' && shift.employeeId !== fromEmp.id) {
      return NextResponse.json(
        { error: 'This shift does not belong to you' },
        { status: 403 }
      )
    }

    // For SWAP/Cover, toEmployeeId is required
    if ((type === 'SWAP' || type === 'COVER') && !toEmployeeId) {
      return NextResponse.json(
        { error: 'toEmployeeId is required for SWAP and COVER types' },
        { status: 400 }
      )
    }

    // Create the change request
    const changeRequest = await prisma.shiftChangeRequest.create({
      data: {
        shiftId,
        fromEmployeeId: fromEmp.id,
        toEmployeeId: toEmployeeId || null,
        type: type as any,
        reason: reason || null,
        status: 'PENDING',
      },
      include: {
        shift: {
          include: {
            clinic: { select: { id: true, name: true } },
          },
        },
        fromEmployee: {
          include: { user: { select: { id: true, name: true } } },
        },
        toEmployee: {
          include: { user: { select: { id: true, name: true } } },
        },
      },
    })

    // Audit log
    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'CREATE',
        entity: 'ShiftChangeRequest',
        entityId: changeRequest.id,
        clinicId: shift.clinicId,
        notes: `Shift change ${type} request for shift ${shiftId}`,
        afterJson: JSON.stringify(changeRequest),
      },
    })

    return NextResponse.json(
      { success: true, changeRequest },
      { status: 201 }
    )
  } catch (error) {
    console.error('Create shift change request error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============================================================
// GET /api/shift-changes — list change requests
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')
    const type = searchParams.get('type')

    const where: any = {}

    // Filter by role
    if (session.role === 'EMPLOYEE') {
      const emp = await prisma.employee.findUnique({
        where: { userId: session.userId },
      })
      if (emp) {
        where.OR = [
          { fromEmployeeId: emp.id },
          { toEmployeeId: emp.id },
        ]
      }
    } else if (session.role === 'MANAGER') {
      // Manager sees requests for their clinics
      where.OR = session.clinics.map((clinicId: string) => ({
        shift: { clinicId },
      }))
    }
    // OWNER sees all

    if (status) where.status = status
    if (type) where.type = type

    const requests = await prisma.shiftChangeRequest.findMany({
      where,
      include: {
        shift: {
          include: {
            clinic: { select: { id: true, name: true } },
            employee: {
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
        fromEmployee: {
          include: { user: { select: { id: true, name: true } } },
        },
        toEmployee: {
          include: { user: { select: { id: true, name: true } } },
        },
        approver: {
          include: { user: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ requests, total: requests.length })
  } catch (error) {
    console.error('Get shift changes error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
