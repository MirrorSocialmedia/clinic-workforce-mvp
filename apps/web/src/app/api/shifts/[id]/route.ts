export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// ============================================================
// PUT /api/shifts/[id] — edit shift
// Roles: OWNER, MANAGER
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  try {
    const id = params.id
    const body = await req.json()

    // Get existing shift
    const existing = await prisma.shift.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Shift not found' }, { status: 404 })
    }

    const beforeJson = JSON.stringify(existing)

    const updateData: any = {}

    if (body.employeeId !== undefined) updateData.employeeId = body.employeeId
    if (body.clinicId !== undefined) updateData.clinicId = body.clinicId
    if (body.date !== undefined) {
      const date = new Date(body.date)
      updateData.date = date
    }
    if (body.startTime !== undefined) {
      updateData.startTime = new Date(body.startTime)
    }
    if (body.endTime !== undefined) {
      updateData.endTime = new Date(body.endTime)
    }
    if (body.role !== undefined) updateData.role = body.role
    if (body.status !== undefined) updateData.status = body.status
    if (body.templateId !== undefined) updateData.templateId = body.templateId

    const shift = await prisma.shift.update({
      where: { id },
      data: updateData,
      include: {
        employee: {
          include: { user: { select: { id: true, name: true } } },
        },
        clinic: { select: { id: true, name: true } },
        template: { select: { id: true, name: true } },
      },
    })

    // Audit log
    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'UPDATE',
        entity: 'Shift',
        entityId: id,
        clinicId: existing.clinicId,
        beforeJson,
        afterJson: JSON.stringify(shift),
      },
    })

    return NextResponse.json({ success: true, shift })
  } catch (error) {
    console.error('Update shift error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============================================================
// DELETE /api/shifts/[id] — delete shift
// Roles: OWNER, MANAGER
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  setAuditContext(
    session.userId,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )

  try {
    const id = params.id

    const existing = await prisma.shift.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Shift not found' }, { status: 404 })
    }

    const beforeJson = JSON.stringify(existing)

    await prisma.shift.delete({ where: { id } })

    // Audit log
    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'DELETE',
        entity: 'Shift',
        entityId: id,
        clinicId: existing.clinicId,
        beforeJson,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete shift error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
