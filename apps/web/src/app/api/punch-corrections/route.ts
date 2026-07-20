export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { hkDateStart, hkDateEnd, toHKDateStr } from '@/lib/hk-date'
import { punchLabel } from '@/lib/punch-label'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

// ============================================================
// POST /api/punch-corrections — Create a punch correction request
// Roles: OWNER, MANAGER, EMPLOYEE
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()
      const { date, punchType, reason, clinicId, employeeId: requestBodyEmployeeId, punchRecordId: requestBodyPunchRecordId, originalPunchType } = body

      // Validate
      if (!date || !punchType || !clinicId) {
        return NextResponse.json(
          { error: 'date, punchType, and clinicId are required' },
          { status: 400 }
        )
      }

      // Reject future punch times (Fix #2a: backend guard + timezone safety)
      const correctedTime = new Date(date)
      if (isNaN(correctedTime.getTime())) {
        return NextResponse.json(
          { error: '時間格式錯誤（需含時區，如 2026-07-14T15:00:00+08:00）' },
          { status: 400 }
        )
      }
      const now = new Date()
      // 60s tolerance for network/server clock drift
      if (correctedTime.getTime() > now.getTime() + 60_000) {
        return NextResponse.json(
          { error: '不能補未來時間的打卡' },
          { status: 400 }
        )
      }

      if (!['CLOCK_IN', 'CLOCK_OUT', 'LUNCH_START', 'LUNCH_END'].includes(punchType)) {
        return NextResponse.json(
          { error: 'punchType must be CLOCK_IN, CLOCK_OUT, LUNCH_START, or LUNCH_END' },
          { status: 400 }
        )
      }

      // Get employee — use provided employeeId (manager) or own profile (employee)
      let employee: any
      if (requestBodyEmployeeId) {
        // Manager creating for another employee
        if (session.role !== 'OWNER' && session.role !== 'MANAGER') {
          return NextResponse.json(
            { error: 'Only managers can create corrections for other employees' },
            { status: 403 }
          )
        }
        employee = await prisma.employee.findUnique({
          where: { id: requestBodyEmployeeId },
          include: { clinics: { select: { clinicId: true } } },
        })
      } else {
        employee = await prisma.employee.findUnique({
          where: { userId: session.userId },
          include: { clinics: { select: { clinicId: true } } },
        })
      }

      if (!employee) {
        return NextResponse.json(
          { error: 'Employee profile not found' },
          { status: 400 }
        )
      }

      // Verify employee belongs to clinic
      const empClinicIds = employee.clinics.map((ec: any) => ec.clinicId)
      if (!empClinicIds.includes(clinicId)) {
        return NextResponse.json(
          { error: 'Employee is not assigned to this clinic' },
          { status: 403 }
        )
      }

      // Derive HK date string from parsed correctedTime for day boundary lookup
      const dayStr = toHKDateStr(correctedTime)
      const dayStart = hkDateStart(dayStr)
      const dayEnd = hkDateEnd(dayStr)

      let punchRecordId: string | null = null
      const existing = await prisma.punchRecord.findFirst({
        where: {
          employeeId: employee.id,
          clinicId,
          punchType: punchType as any,
          punchTime: { gte: dayStart, lte: dayEnd },
          void: { is: null }, // 已作廢的不算存在
        },
      })

      if (existing) {
        // Existing record found — link correction to it (correction semantics: overlay, don't create duplicate)
        punchRecordId = existing.id
      }

      // Transaction: create correction + punchRecord (if no original exists)
      const correction = await prisma.$transaction(async (tx) => {
        const isManager = session.role === 'OWNER' || session.role === 'MANAGER'

        // ★ Check if punchType changed (originalPunchType provided and different)
        let voidedOriginalId: string | null = null
        let newPunchRecordId: string | null = null
        const isTypeChange = originalPunchType && originalPunchType !== punchType

        if (isTypeChange && isManager) {
          // Find the original punchRecord by original type
          const original = await tx.punchRecord.findFirst({
            where: {
              employeeId: employee.id,
              clinicId,
              punchType: originalPunchType as any,
              punchTime: { gte: dayStart, lte: dayEnd },
              void: { is: null },
            },
          })

          if (original) {
            // 1. Void original punchRecord
            await tx.punchRecord.update({
              where: { id: original.id },
              data: { void: { create: { reason: `類型變更: ${originalPunchType} → ${punchType}`, voidedBy: session.userId } } },
            })
            voidedOriginalId = original.id

            // Audit: void original
            await tx.auditLog.create({
              data: {
                actorId: session.userId,
                action: 'VOID_PUNCH',
                entity: 'PunchRecord',
                entityId: original.id,
                clinicId,
                beforeJson: JSON.stringify({ punchType: original.punchType, punchTime: original.punchTime }),
                afterJson: JSON.stringify({ voidReason: `類型變更: ${originalPunchType} → ${punchType}` }),
                notes: `作廢原記錄（類型變更）: ${originalPunchType} → ${punchType}`,
                ipAddress: req.headers.get('x-forwarded-for') || null,
                userAgent: req.headers.get('user-agent') || null,
              },
            })

            // 2. Create new punchRecord with new type
            const newRecord = await tx.punchRecord.create({
              data: {
                employeeId: employee.id,
                clinicId,
                punchTime: correctedTime,
                punchType: punchType as any,
                source: 'CORRECTION' as any,
              },
            })
            newPunchRecordId = newRecord.id

            // Audit: type change
            await tx.auditLog.create({
              data: {
                actorId: session.userId,
                action: 'CREATE_PUNCH',
                entity: 'PunchRecord',
                entityId: newRecord.id,
                clinicId,
                beforeJson: JSON.stringify({ punchType: originalPunchType, punchRecordId: original.id }),
                afterJson: JSON.stringify({ punchType, punchRecordId: newRecord.id, reason: `類型變更: ${originalPunchType} → ${punchType}` }),
                notes: `補登類型變更: ${originalPunchType} → ${punchType}`,
                ipAddress: req.headers.get('x-forwarded-for') || null,
                userAgent: req.headers.get('user-agent') || null,
              },
            })
          }
        }

        const c = await tx.punchCorrection.create({
          data: {
            punchRecordId: newPunchRecordId || punchRecordId,
            employeeId: employee.id,
            clinicId,
            correctedTime: new Date(date),
            punchType: punchType as any,
            reason: isTypeChange ? `類型變更: ${originalPunchType} → ${punchType}${reason ? '; ' + reason : ''}` : (reason || null),
            requestedBy: session.userId,
            status: isManager ? 'APPROVED' : 'PENDING',
            approvedBy: isManager ? session.userId : null,
          },
        })

        // If APPROVED and no original punchRecord exists → create one (source=CORRECTION)
        if (isManager && !punchRecordId && !newPunchRecordId) {
          const pr = await tx.punchRecord.create({
            data: {
              employeeId: employee.id,
              clinicId,
              punchTime: new Date(date),
              punchType: punchType as any,
              source: 'MANUAL_CORRECTION' as const,
            },
          })
          // Backfill correction's punchRecordId
          await tx.punchCorrection.update({
            where: { id: c.id },
            data: { punchRecordId: pr.id },
          })

          // Audit: new punch record via correction
          await tx.auditLog.create({
            data: {
              actorId: session.userId,
              action: 'CREATE_PUNCH',
              entity: 'PunchRecord',
              entityId: pr.id,
              clinicId,
              beforeJson: null,
              afterJson: JSON.stringify({ punchType: pr.punchType, punchTime: pr.punchTime, employeeId: pr.employeeId, reason: body.reason }),
              notes: `補登 ${punchLabel(pr.punchType)} ${body.reason || ''}`,
              ipAddress: req.headers.get('x-forwarded-for') || null,
              userAgent: req.headers.get('user-agent') || null,
            },
          })
        }

        return c
      })

      // Invalidate TimeBank from correction date so carry chain recalculates (only for APPROVED)
      if (correction.status === 'APPROVED') {
        await invalidateTimeBankFrom(correction.employeeId, correction.correctedTime, prisma)
      }

      return NextResponse.json(
        { success: true, correction, createdPunchRecord: !!(!existing && (session.role === 'OWNER' || session.role === 'MANAGER')) },
        { status: 201 }
      )
    } catch (error) {
      console.error('Punch correction error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}

// ============================================================
// GET /api/punch-corrections — List punch corrections
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const employeeId = searchParams.get('employeeId')
  const status = searchParams.get('status')

  const where: any = {}

  // EMPLOYEE only sees their own corrections
  if (scope === 'self') {
    const emp = await prisma.employee.findUnique({
      where: { userId: session.userId },
    })
    if (emp) {
      where.employeeId = emp.id
    }
  }

  if (clinicId) where.clinicId = clinicId
  if (employeeId && scope !== 'self') where.employeeId = employeeId
  if (status) where.status = status

  // MANAGER only sees their clinics
  if (scope === 'my-clinics' && session.clinics.length > 0) {
    where.clinicId = { in: session.clinics }
  }

  const corrections = await prisma.punchCorrection.findMany({
    where,
    include: {
      punchRecord: {
        include: {
          employee: {
            include: {
              user: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return NextResponse.json({ corrections })
}
