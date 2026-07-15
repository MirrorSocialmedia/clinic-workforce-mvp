export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hkDateStart, toHKDateStr } from '@/lib/hk-date'
import { rebuildShiftDate, buildShiftFromInput } from '@/lib/shift-write'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'

// PUT /api/shifts/[id] — edit shift
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const id = params.id
    const body = await req.json()

    const existing = await prisma.shift.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Shift not found' }, { status: 404 })

    const beforeJson = JSON.stringify(existing)
    const updateData: any = {}

    if (body.employeeId !== undefined) updateData.employeeId = body.employeeId
    if (body.clinicId !== undefined) updateData.clinicId = body.clinicId

    if (body.date !== undefined) {
      // Date changed — rebuild all three columns via helper
      // If startTime/endTime also provided (edit modal), use those; otherwise preserve original HK times
      if (body.startTime !== undefined || body.endTime !== undefined) {
        const newStart = body.startTime ?? existing.startTime.toISOString()
        const newEnd = body.endTime ?? existing.endTime.toISOString()
        Object.assign(updateData, buildShiftFromInput(body.date, newStart, newEnd))
      } else {
        Object.assign(updateData, rebuildShiftDate(existing, body.date))
      }
    } else if (body.startTime !== undefined || body.endTime !== undefined) {
      // Only times changed (no date change) — rebuild via helper
      const dateStr = toHKDateStr(existing.date)
      const newStart = body.startTime ?? existing.startTime.toISOString()
      const newEnd = body.endTime ?? existing.endTime.toISOString()
      Object.assign(updateData, buildShiftFromInput(dateStr, newStart, newEnd))
    }

    if (body.role !== undefined) updateData.role = body.role
    if (body.status !== undefined) updateData.status = body.status
    if (body.templateId !== undefined) updateData.templateId = body.templateId

    const shift = await prisma.shift.update({
      where: { id },
      data: updateData,
      include: {
        employee: { include: { user: { select: { id: true, name: true } } } },
        clinic: { select: { id: true, name: true } },
        template: { select: { id: true, name: true } },
      },
    })

    // Audit handled by Prisma extension (Shift ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true, shift })
  })
}

// DELETE /api/shifts/[id] — delete shift
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const id = params.id
    const existing = await prisma.shift.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Shift not found' }, { status: 404 })

    const beforeJson = JSON.stringify(existing)
    await prisma.shift.delete({ where: { id } })

    // Audit handled by Prisma extension (Shift ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true })
  })
}
