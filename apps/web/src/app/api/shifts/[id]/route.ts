export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hkDateStart, toHKDateStr, getMonthRange } from '@/lib/hk-date'
import { rebuildShiftDate, buildShiftFromInput } from '@/lib/shift-write'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { runWithAudit } from '@/lib/audit-context'
import { writeAuditLog } from '@/lib/prisma'
import { checkShiftLeaveConflict } from '@/lib/shift-validator'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { revokeStaleEarlyOt } from '@/lib/early-in-ot'
import { describeShiftChange, buildNotification, shiftDeletedMsg } from '@/lib/notification-messages'
import { createNotification } from '@/lib/notification'

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

    // ★ Prepare clinic name map for notification messages
    const clinics = await prisma.clinic.findMany({ select: { id: true, name: true } })
    const clinicNameMap = new Map(clinics.map(c => [c.id, c.name]))

    // ★ MANAGER 只可以動自己店嘅更
    // ★ 用 resolveClinicScope 取代 assertClinicAccess（2026-08-03）
    // forPerms: 編輯排班 → companyWide（排班跨店）
    const allowedClinics = await resolveClinicScope(session, auth.perms ?? [], {
      companyWide: ['attendance_manage', 'scheduling'],
    })
    if (allowedClinics !== null && !allowedClinics.includes(existing.clinicId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ★ 調鋪：改店時目標店都要喺權限內
    if (body.clinicId !== undefined) {
      if (allowedClinics !== null && !allowedClinics.includes(body.clinicId)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // ★ secondaryClinicId 也要檢查權限
    if (body.secondaryClinicId) {
      if (allowedClinics !== null && !allowedClinics.includes(body.secondaryClinicId)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
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

    // ★ Capture before-update snapshot for notification
    const wasConfirmed = existing.status === 'CONFIRMED'
    const beforeSnapshot = {
      date: existing.date, startTime: existing.startTime,
      endTime: existing.endTime, clinicId: existing.clinicId,
      secondaryClinicId: existing.secondaryClinicId,
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

    // ★ Notify employee if shift was CONFIRMED and changed
    if (wasConfirmed) {
      const msg = describeShiftChange(beforeSnapshot, shift, (cid) => clinicNameMap.get(cid) ?? '')
      await createNotification(buildNotification(shift.employeeId, [msg], shift.id))
    }

    // ★ 排班變更影響遲到／早退／OT 判斷 → 新舊日期都要失效（改期會影響兩個月）
    try {
      await invalidateTimeBankFrom(existing.employeeId, existing.date, prisma)
    } catch (e) {
      console.error(`[timebank-cache] invalidate failed employeeId=${existing.employeeId} date=${existing.date}`, e)
    }
    if (updateData.date) {
      try {
        await invalidateTimeBankFrom(existing.employeeId, updateData.date, prisma)
      } catch (e) {
        console.error(`[timebank-cache] invalidate failed employeeId=${existing.employeeId} date=${updateData.date}`, e)
      }
    }

    // ★ 2026-08-08: Revoke stale early-in OT on shift changes (old + new date)
    try {
      const oldDate = toHKDateStr(existing.date)
      await revokeStaleEarlyOt(existing.employeeId, oldDate, session.userId, 'SHIFT_EDIT', prisma)
    } catch (e) {
      console.error(`[early-in-ot] revoke failed employeeId=${existing.employeeId}`, e)
    }
    if (updateData.date) {
      try {
        const newDate = toHKDateStr(updateData.date)
        await revokeStaleEarlyOt(existing.employeeId, newDate, session.userId, 'SHIFT_EDIT', prisma)
      } catch (e) {
        console.error(`[early-in-ot] revoke failed employeeId=${existing.employeeId}`, e)
      }
    }

    // ★ 已出糧警告：檢查新日期/診所嘅月份有冇已 FINALIZED/EXPORTED 嘅糧單（§四.E）
    const checkClinicId = updateData.clinicId ?? existing.clinicId
    const checkDate = updateData.date || existing.date
    const dateStr = toHKDateStr(checkDate instanceof Date ? checkDate : new Date(checkDate + 'T00:00:00+08:00'))
    const { start: pm } = getMonthRange(checkDate instanceof Date ? checkDate : new Date(checkDate + 'T00:00:00+08:00'))
    const locked = await prisma.payrollRun.findFirst({
      where: {
        periodMonth: pm,
        status: { in: ['FINALIZED', 'EXPORTED'] },
        OR: [{ clinicId: null }, { clinicId: checkClinicId }],
      },
      select: { id: true, status: true, clinicId: true },
    })
    if (locked) {
      await writeAuditLog({
        action: 'SHIFT_EDIT_AFTER_PAYROLL',
        entity: 'Shift',
        entityId: id,
        notes: `${dateStr} 屬於已${locked.status === 'EXPORTED' ? '匯出' : '確認'}嘅計糧月份，糧單唔會自動更新`,
      })
    }

    // Audit handled by Prisma extension (Shift ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true, shift, payrollLocked: locked ? {
      month: `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}`,
      status: locked.status,
    } : null })
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
    // ★ 用 resolveClinicScope 取代 assertClinicAccess（2026-08-03）
    // forPerms: 刪除排班 → companyWide（排班跨店）
    const allowedClinics = await resolveClinicScope(session, auth.perms ?? [], {
      companyWide: ['attendance_manage', 'scheduling'],
    })
    if (allowedClinics !== null && !allowedClinics.includes(existing.clinicId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const wasConfirmed = existing.status === 'CONFIRMED'
    await prisma.shift.delete({ where: { id } })

    // ★ Notify employee if deleted shift was CONFIRMED
    if (wasConfirmed) {
      const clinics = await prisma.clinic.findMany({ select: { id: true, name: true } })
      const clinicNameMap = new Map(clinics.map(c => [c.id, c.name]))
      await createNotification(buildNotification(
        existing.employeeId,
        [shiftDeletedMsg(existing, (cid) => clinicNameMap.get(cid) ?? '')],
        // relatedId = undefined — 更次已刪，冇關聯 ID
      ))
    }

    // ★ 已出糧警告：檢查被刪更嘅月份有冇已 FINALIZED/EXPORTED 嘅糧單（§四.E）
    const { start: pm } = getMonthRange(existing.date)
    const locked = await prisma.payrollRun.findFirst({
      where: {
        periodMonth: pm,
        status: { in: ['FINALIZED', 'EXPORTED'] },
        OR: [{ clinicId: null }, { clinicId: existing.clinicId }],
      },
      select: { id: true, status: true, clinicId: true },
    })
    if (locked) {
      await writeAuditLog({
        action: 'SHIFT_EDIT_AFTER_PAYROLL',
        entity: 'Shift',
        entityId: id,
        notes: `${toHKDateStr(existing.date)} 屬於已${locked.status === 'EXPORTED' ? '匯出' : '確認'}嘅計糧月份，糧單唔會自動更新`,
      })
    }

    // ★ 刪除排班影響遲到／早退／OT 判斷 → 快取要失效
    try {
      await invalidateTimeBankFrom(existing.employeeId, existing.date, prisma)
    } catch (e) {
      console.error(`[timebank-cache] invalidate failed employeeId=${existing.employeeId} date=${existing.date}`, e)
    }

    // ★ 2026-08-08: Revoke stale early-in OT on shift delete
    try {
      const hkDate = toHKDateStr(existing.date)
      await revokeStaleEarlyOt(existing.employeeId, hkDate, session.userId, 'SHIFT_DELETE', prisma)
    } catch (e) {
      console.error(`[early-in-ot] revoke failed employeeId=${existing.employeeId}`, e)
    }

    // Audit handled by Prisma extension (Shift ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true, payrollLocked: locked ? {
      month: `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}`,
      status: locked.status,
    } : null })
  })
}
