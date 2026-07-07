export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { validateShift, validateShiftBatch, type ShiftInput } from '@/lib/shift-validator'
import { toHKDateStr } from '@/lib/hk-date'

// ============================================================
// POST /api/shifts/validate — validate shift against rules
// Roles: OWNER, MANAGER
// ============================================================
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  try {
    const body = await req.json()
    const { shift, shifts, mode = 'single' } = body

    if (mode === 'batch' && shifts && Array.isArray(shifts)) {
      const existingShifts = await prisma.shift.findMany({
        select: {
          id: true, employeeId: true, clinicId: true, date: true,
          startTime: true, endTime: true, role: true, status: true,
        },
      })

      const existingInputs: ShiftInput[] = existingShifts.map(s => ({
        id: s.id, employeeId: s.employeeId, clinicId: s.clinicId,
        date: toHKDateStr(s.date),
        startTime: s.startTime.toISOString(), endTime: s.endTime.toISOString(),
        role: s.role || undefined, status: s.status,
      }))

      const newInputs: ShiftInput[] = shifts.map((s: any) => ({
        id: s.id, employeeId: s.employeeId, clinicId: s.clinicId,
        date: s.date, startTime: s.startTime, endTime: s.endTime,
        role: s.role || undefined,
      }))

      const result = await validateShiftBatch(newInputs, existingInputs)
      return NextResponse.json(result)
    } else {
      if (!shift) {
        return NextResponse.json({ error: 'shift object required' }, { status: 400 })
      }

      const existingShifts = await prisma.shift.findMany({
        where: { employeeId: shift.employeeId, status: { not: 'CANCELLED' } },
        select: {
          id: true, employeeId: true, clinicId: true, date: true,
          startTime: true, endTime: true, role: true, status: true,
        },
      })

      const existingInputs: ShiftInput[] = existingShifts.map(s => ({
        id: s.id, employeeId: s.employeeId, clinicId: s.clinicId,
        date: toHKDateStr(s.date),
        startTime: s.startTime.toISOString(), endTime: s.endTime.toISOString(),
        role: s.role || undefined, status: s.status,
      }))

      const shiftInput: ShiftInput = {
        id: shift.id, employeeId: shift.employeeId, clinicId: shift.clinicId,
        date: shift.date, startTime: shift.startTime, endTime: shift.endTime,
        role: shift.role || undefined, status: shift.status,
      }

      const result = await validateShift(shiftInput, existingInputs)
      return NextResponse.json(result)
    }
  } catch (error) {
    console.error('Shift validation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
