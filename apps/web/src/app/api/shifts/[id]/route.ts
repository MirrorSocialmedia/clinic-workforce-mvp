export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hkDateStart } from '@/lib/hk-date'
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
      // Parse date-only strings as Hong Kong midnight to avoid UTC midnight issue
      const d = body.date
      updateData.date = d.includes('T') || d.includes('Z') ? new Date(d) : hkDateStart(d)
    }
    if (body.startTime !== undefined) updateData.startTime = new Date(body.startTime)
    if (body.endTime !== undefined) updateData.endTime = new Date(body.endTime)

    // FIX: When date changes, rebuild startTime/endTime to preserve time-of-day
    // so calendar and overview stay in sync (date, startTime, endTime all same day)
    if (body.date !== undefined && body.date !== existing.date.toISOString().slice(0, 10)) {
      const fmtTime = (d: Date) => {
        const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', hour12: false }).format(d)
        const m = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', minute: '2-digit' }).format(d)
        return `${h}:${m}`
      }
      const baseDate = updateData.date instanceof Date ? updateData.date.toISOString().slice(0, 10) : updateData.date.slice(0, 10)
      const newStart = new Date(`${baseDate}T${fmtTime(existing.startTime)}:00+08:00`)
      const newEnd0 = new Date(`${baseDate}T${fmtTime(existing.endTime)}:00+08:00`)
      // Overnight shift (end time <= start time) → end day +1
      const newEnd = newEnd0 <= newStart ? new Date(newEnd0.getTime() + 86400000) : newEnd0
      updateData.startTime = newStart
      updateData.endTime = newEnd
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
