export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { validateShift, validateShiftBatch, type ShiftInput } from '@/lib/shift-validator'

// ============================================================
// POST /api/shifts/validate — validate shift against rules
// Roles: OWNER, MANAGER
// ============================================================
export async function POST(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const { shift, shifts, mode = 'single' } = body

    if (mode === 'batch' && shifts && Array.isArray(shifts)) {
      // Batch validation
      const existingShifts = await prisma.shift.findMany({
        select: {
          id: true,
          employeeId: true,
          clinicId: true,
          date: true,
          startTime: true,
          endTime: true,
          role: true,
          status: true,
        },
      })

      const existingInputs: ShiftInput[] = existingShifts.map(s => ({
        id: s.id,
        employeeId: s.employeeId,
        clinicId: s.clinicId,
        date: s.date.toISOString().split('T')[0],
        startTime: s.startTime.toISOString(),
        endTime: s.endTime.toISOString(),
        role: s.role || undefined,
        status: s.status,
      }))

      const newInputs: ShiftInput[] = shifts.map((s: any) => ({
        id: s.id,
        employeeId: s.employeeId,
        clinicId: s.clinicId,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        role: s.role || undefined,
      }))

      const result = await validateShiftBatch(newInputs, existingInputs)
      return NextResponse.json(result)
    } else {
      // Single shift validation
      if (!shift) {
        return NextResponse.json(
          { error: 'shift object required' },
          { status: 400 }
        )
      }

      // Fetch existing shifts for comparison
      const existingShifts = await prisma.shift.findMany({
        where: {
          employeeId: shift.employeeId,
          status: { not: 'CANCELLED' },
        },
        select: {
          id: true,
          employeeId: true,
          clinicId: true,
          date: true,
          startTime: true,
          endTime: true,
          role: true,
          status: true,
        },
      })

      const existingInputs: ShiftInput[] = existingShifts.map(s => ({
        id: s.id,
        employeeId: s.employeeId,
        clinicId: s.clinicId,
        date: s.date.toISOString().split('T')[0],
        startTime: s.startTime.toISOString(),
        endTime: s.endTime.toISOString(),
        role: s.role || undefined,
        status: s.status,
      }))

      const shiftInput: ShiftInput = {
        id: shift.id,
        employeeId: shift.employeeId,
        clinicId: shift.clinicId,
        date: shift.date,
        startTime: shift.startTime,
        endTime: shift.endTime,
        role: shift.role || undefined,
        status: shift.status,
      }

      const result = await validateShift(shiftInput, existingInputs)
      return NextResponse.json(result)
    }
  } catch (error) {
    console.error('Shift validation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
