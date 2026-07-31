export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hkDateStart, toHKDateStr } from '@/lib/hk-date'
import { rebuildShiftDate, buildShiftFromInput } from '@/lib/shift-write'
import { requirePerm, isAuthError, assertClinicAccess } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { checkShiftLeaveConflict } from '@/lib/shift-validator'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

// PUT /api/shifts/[id] — edit shift
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePerm(req, 'scheduling')
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

    // ★ MANAGER 只可以動自己店嘅更
    const denied = assertClinicAccess(scope, session, existing.clinicId)
    if (denied) return denied

    // ★ 調鋪：改店時目標店都要喺權限內
    if (body.clinicId !== undefined) {
      const deniedTarget = assertClinicAccess(scope, session, body.clinicId)
      if (deniedTarget) return deniedTarget
    }

    // ★ secondaryClinicId 也要檢查權限
    if (body.secondaryClinicId) {
      const deniedSecondary = assertClinicAccess(scope, session, body.secondaryClinicId)
      if (deniedSecondary) return deniedSecondary
      // ★ 調鋪店不可與主店相同
      if (body.secondaryClinicId === existing.clinicId) {
        return NextResponse.json({ error: '調鋪店不可與主店相同' }, { status: 400 })
      }
    }

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
    if (body.secondaryClinicId !== undefined) updateData.secondaryClinicId = body.secondaryClinicId || null

    // ★ D1: check collision before writing
    const targetStart = updateData.startTime ?? existing.startTime
    const targetEnd = updateData.endTime ?? existing.endTime
    const targetEmp = updateData.employeeId ?? existing.employeeId

    const overlap = await prisma.shift.findFirst({
      where: {
        id: { not: id },
        employeeId: targetEmp,
        status: { not: 'CANCELLED' },
        date: { gte: new Date(targetStart.getTime() - 86400000), lte: targetEnd },
        startTime: { lt: targetEnd },
        endTime: { gt: targetStart },
      },
      select: { id: true, clinicId: true, startTime: true, endTime: true },
    })
    if (overlap) {
      return NextResponse.json(
        { error: '該員工在此時段已有排班', conflictShiftId: overlap.id },
        { status: 409 }
      )
    }

    // Fix: check leave conflict after rebuildShiftDate, before write
    const targetEmpId = updateData.employeeId || existing.employeeId
    const targetDate = updateData.date || existing.date
    const leaveConflict = await checkShiftLeaveConflict(targetEmpId, targetDate)
    if (leaveConflict.conflict) {
      return NextResponse.json(
        { error: `該員工該天已有假期（${leaveConflict.leaveName}），無法排班` },
        { status: 409 }
      )
    }

    const shift = await prisma.shift.update({
      where: { id },
      data: updateData,
      include: {
        employee: { include: { user: { select: { id: true, name: true } } } },
        clinic: { select: { id: true, name: true } },
        template: { select: { id: true, name: true } },
      },
    }).catch(async (e: any) => {
      // ★ P2002: unique constraint violation
      if (e?.code === 'P2002') {
        return NextResponse.json(
          { error: '該時段已有相同排班（可能重複提交）' },
          { status: 409 }
        )
      }
      throw e
    })

    if (shift instanceof NextResponse) return shift

    // ★ 排班變更影響遲到／早退／OT 判斷 → 新舊日期都要失效（改期會影響兩個月）
    await invalidateTimeBankFrom(existing.employeeId, existing.date, prisma)
    if (updateData.date) {
      await invalidateTimeBankFrom(existing.employeeId, updateData.date, prisma)
    }

    // Audit handled by Prisma extension (Shift ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true, shift })
  })
}

// DELETE /api/shifts/[id] — delete shift
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const id = params.id
    const existing = await prisma.shift.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Shift not found' }, { status: 404 })

    // ★ MANAGER 只可以動自己店嘅更
    const denied = assertClinicAccess(scope, session, existing.clinicId)
    if (denied) return denied

    const beforeJson = JSON.stringify(existing)
    await prisma.shift.delete({ where: { id } })

    // ★ 刪除排班影響遲到／早退／OT 判斷 → 快取要失效
    await invalidateTimeBankFrom(existing.employeeId, existing.date, prisma)

    // Audit handled by Prisma extension (Shift ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true })
  })
}
