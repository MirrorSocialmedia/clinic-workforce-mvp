export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr } from '@/lib/hk-date'

// ============================================================
// GET /api/my/schedule — My upcoming schedule
// All roles — returns the current employee's shifts
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const includeCoworkers = searchParams.get('includeCoworkers') === 'true'

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const where: any = { employeeId: employee.id }

  if (from) {
    where.startTime = { gte: new Date(from) }
  } else {
    where.startTime = { gte: new Date() }
  }

  if (to) {
    where.startTime = { ...where.startTime, lte: new Date(to) }
  }

  const shifts = await prisma.shift.findMany({
    where,
    include: {
      clinic: { select: { id: true, name: true, address: true } },
      template: { select: { id: true, name: true } },
      employee: {
        include: {
          user: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { startTime: 'asc' },
    take: 50,
  })

  // If includeCoworkers, fetch coworker shifts for same clinics & dates
  let coworkerShifts: any[] = []
  if (includeCoworkers && shifts.length > 0) {
    const clinicIds = [...new Set(shifts.map(s => s.clinicId).filter(Boolean))]
    const dates = shifts.map(s => s.startTime)
    const minDate = new Date(Math.min(...dates.map(d => new Date(d).getTime())))
    const maxDate = new Date(Math.max(...dates.map(d => new Date(d).getTime())))
    maxDate.setUTCDate(maxDate.getUTCDate() + 1) // inclusive

    if (clinicIds.length > 0) {
      const allShifts = await prisma.shift.findMany({
        where: {
          clinicId: { in: clinicIds },
          employeeId: { not: employee.id },
          startTime: { gte: minDate, lte: maxDate },
        },
        include: {
          clinic: { select: { id: true, name: true } },
          template: { select: { id: true, name: true } },
          employee: {
            include: {
              user: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { startTime: 'asc' },
        take: 200,
      })

      coworkerShifts = allShifts.map(s => ({
        id: s.id,
        date: toHKDateStr(new Date(s.startTime)),
        startTime: s.startTime,
        endTime: s.endTime,
        employeeName: s.employee?.user?.name || '未知',
        templateName: s.template?.name || '',
        clinicName: s.clinic?.name || '',
      }))
    }
  }

  const formattedShifts = shifts.map(s => ({
    ...s,
    date: toHKDateStr(new Date(s.startTime)),
    startTime: s.startTime,
    endTime: s.endTime,
    employeeName: s.employee?.user?.name || '',
    templateName: s.template?.name || '',
    clinicName: s.clinic?.name || '',
  }))

  if (includeCoworkers) {
    return NextResponse.json({ myShifts: formattedShifts, coworkerShifts })
  }

  return NextResponse.json({ shifts: formattedShifts })
}
