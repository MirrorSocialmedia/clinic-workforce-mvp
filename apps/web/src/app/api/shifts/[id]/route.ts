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
import { lockEmployee, lockEmployees, HttpError, toHttpResponse } from '@/lib/emp-lock'

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

    // ★ Capture before-update snapshot for notification
    const wasConfirmed = existing.status === 'CONFIRMED'
    const beforeSnapshot = {
      date: existing.date, startTime: existing.startTime,
      endTime: existing.endTime, clinicId: existing.clinicId,
      secondaryClinicId: existing.secondaryClinicId,
    }

    let shift
    try {
      shift = await prisma.$transaction(async (tx) => {
        await lockEmployees(tx, [existing.employeeId, updateData.employeeId])
        // ★ D1 拍板：排更維持「警告照改」，唔加硬鎖（靠 4B 凍結期末兜底）—— Stage 4 只收窄下面警告嘅範圍
        const empId = updateData.employeeId ?? existing.employeeId
        // overlap：喺鎖入面再驗（排除自己）
        const overlap = await tx.shift.findFirst({
          where: {
            id: { not: existing.id },
            employeeId: empId,
            status: { not: 'CANCELLED' },
            date: { gte: new Date(targetStart.getTime() - 86400000), lte: targetEnd },
            startTime: { lt: targetEnd },
            endTime: { gt: targetStart },
          },
          select: { id: true, clinicId: true, startTime: true, endTime: true },
        })
        if (overlap) throw new HttpError(409, '該員工在此時段已有排班', { conflictShiftId: overlap.id })

        // leave：喺鎖入面再驗
        const targetDate = updateData.date || existing.date
        const leaveConflict = await checkShiftLeaveConflict(empId, targetDate, tx)
        if (leaveConflict.conflict) throw new HttpError(409, `該員工該天已有假期（${leaveConflict.leaveName}），無法排班`)

        const updated = await tx.shift.update({
          where: { id: existing.id },
          data: updateData,
          include: {
            employee: { include: { user: { select: { id: true, name: true } } } },
            clinic: { select: { id: true, name: true } },
            template: { select: { id: true, name: true } },
          },
        })

        // ★ Stage 2.4：排班變更影響遲到／早退／OT 判斷 → 快取失效 + OT 撤回入 tx（失敗 = rollback）
        //   PUT 換員工：**新舊員工 × 新舊日期**都做（改期會影響兩個月）
        const newEmpId = updateData.employeeId ?? existing.employeeId
        const affectedEmpIds = newEmpId === existing.employeeId ? [newEmpId] : [newEmpId, existing.employeeId]
        const oldDateStr = toHKDateStr(existing.date)
        const newDateStr = toHKDateStr(updateData.date || existing.date)
        for (const eid of affectedEmpIds) {
          await invalidateTimeBankFrom(eid, existing.date, tx)
          if (updateData.date) await invalidateTimeBankFrom(eid, updateData.date, tx)
          await revokeStaleEarlyOt(eid, oldDateStr, session.userId, 'SHIFT_EDIT', tx)
          if (updateData.date) await revokeStaleEarlyOt(eid, newDateStr, session.userId, 'SHIFT_EDIT', tx)
        }

        return updated
      })
    } catch (error) {
      // ★ L-6：P2002 用返舊訊息（toHttpResponse 預設「已處理（重複提交）」會誤導）
      { const r = toHttpResponse(error, '該時段已有相同排班（可能重複提交）'); if (r) return r }
      throw error
    }

    // ★ Notify employee if shift was CONFIRMED and changed
    if (wasConfirmed) {
      const msg = describeShiftChange(beforeSnapshot, shift, (cid) => clinicNameMap.get(cid) ?? '')
      await createNotification(buildNotification(shift.employeeId, [msg], shift.id))
    }

    // ★ 已出糧警告：檢查新日期/診所嘅月份有冇已 FINALIZED/EXPORTED 嘅糧單（§四.E）
    const checkDate = updateData.date || existing.date
    const dateStr = toHKDateStr(checkDate instanceof Date ? checkDate : new Date(checkDate + 'T00:00:00+08:00'))
    const { start: pm } = getMonthRange(checkDate instanceof Date ? checkDate : new Date(checkDate + 'T00:00:00+08:00'))
    // ★ Stage 4A：同 assertMonthsUnlockedTx 同一範圍（員工實際入咗嗰張 run）；換咗員工就新舊兩個都查
    const checkEmpIds = updateData.employeeId && updateData.employeeId !== existing.employeeId
      ? [existing.employeeId, updateData.employeeId]
      : [existing.employeeId]
    const locked = await prisma.payrollRun.findFirst({
      where: {
        periodMonth: pm,
        status: { in: ['FINALIZED', 'EXPORTED'] },
        items: { some: { employeeId: { in: checkEmpIds } } },
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
      month: toHKDateStr(pm).slice(0, 7),
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
    try {
      await prisma.$transaction(async (tx) => {
        await lockEmployee(tx, existing.employeeId)
        await tx.shift.delete({ where: { id } })
        // ★ Stage 2.4：刪除排班影響遲到／早退／OT 判斷 → 快取失效 + OT 撤回入 tx（失敗 = rollback）
        await invalidateTimeBankFrom(existing.employeeId, existing.date, tx)
        await revokeStaleEarlyOt(existing.employeeId, toHKDateStr(existing.date), session.userId, 'SHIFT_DELETE', tx)
      })
    } catch (e: any) {
      { const r = toHttpResponse(e); if (r) return r }   // ★ H0-2c BUSY 等
      // ★ L-6：已經被刪（例如清空週同拖刪撞）→ 409，唔好 500（清空週會當失敗列出）
      if (e?.code === 'P2025') return NextResponse.json({ error: '呢張更已經刪咗', code: 'ALREADY_DELETED' }, { status: 409 })
      if (e?.code === 'P2003') return NextResponse.json({ error: '呢張更仲有關聯記錄，唔可以直接刪' }, { status: 409 })
      throw e
    }

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
        items: { some: { employeeId: existing.employeeId } },   // ★ Stage 4A：同 assertMonthsUnlockedTx 同一範圍
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

    // Audit handled by Prisma extension (Shift ∈ AUDIT_ENTITIES)

    return NextResponse.json({ success: true, payrollLocked: locked ? {
      month: toHKDateStr(pm).slice(0, 7),
      status: locked.status,
    } : null })
  })
}
