export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/my/company-overview — Company-wide schedule overview for a week
// All roles. Uses employee's clinics → company → all clinics in company.
// Query: ?weekStart=2026-07-13
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { searchParams } = new URL(req.url)
  const weekStartStr = searchParams.get('weekStart')
  if (!weekStartStr) {
    return NextResponse.json({ error: 'weekStart is required (YYYY-MM-DD)' }, { status: 400 })
  }

  const weekStart = new Date(weekStartStr + 'T00:00:00')
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 7)

  // 1. Find employee → clinics → companyIds
  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
    include: {
      clinics: { include: { clinic: { select: { id: true, companyId: true } } } },
    },
  })

  if (!employee) {
    return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })
  }

  const clinicIds = employee.clinics.map(ec => ec.clinic.id)
  if (clinicIds.length === 0) {
    return NextResponse.json({ error: 'No clinics associated' }, { status: 400 })
  }

  const companyIds = [...new Set(
    employee.clinics.map(ec => ec.clinic.companyId).filter(Boolean as () => boolean)
  )] as string[]

  if (companyIds.length === 0) {
    return NextResponse.json({ error: 'Clinics not linked to a company' }, { status: 400 })
  }

  // 2. Get all clinics in those companies
  const allClinics = await prisma.clinic.findMany({
    where: { companyId: { in: companyIds } },
    select: { id: true, name: true, companyId: true },
  })

  const allClinicIds = allClinics.map(c => c.id)

  // 3. Get all employees in those clinics
  const allEmployeeClinics = await prisma.employeeClinic.findMany({
    where: { clinicId: { in: allClinicIds } },
    include: {
      employee: {
        include: {
          user: { select: { id: true, name: true } },
        },
      },
    },
  })

  const employees = new Map<string, {
    id: string
    userId: string
    name: string
    clinics: { id: string; name: string }[]
  }>()

  for (const ec of allEmployeeClinics) {
    const emp = ec.employee
    const user = emp.user
    const key = emp.id
    if (!employees.has(key)) {
      employees.set(key, {
        id: emp.id,
        userId: emp.userId,
        name: user.name || '(unknown)',
        clinics: [],
      })
    }
    employees.get(key)!.clinics.push({ id: ec.clinicId, name: '' })
  }

  // Attach clinic names
  const clinicNameMap = new Map(allClinics.map(c => [c.id, c.name]))
  for (const emp of employees.values()) {
    emp.clinics = emp.clinics.map(c => ({ id: c.id, name: clinicNameMap.get(c.id) || '' }))
  }

  const employeeIds = [...employees.keys()]
  const currentUserId = session.userId

  // 4. Get shifts for the week for all these employees
  const shifts = await prisma.shift.findMany({
    where: {
      employeeId: { in: employeeIds },
      clinicId: { in: allClinicIds },
      startTime: { gte: weekStart, lt: weekEnd },
    },
    include: {
      clinic: { select: { id: true, name: true } },
      template: { select: { id: true, name: true } },
    },
  })

  // 5. Get approved leave requests for the week
  const leaveRequests = await prisma.leaveRequest.findMany({
    where: {
      employeeId: { in: employeeIds },
      status: 'APPROVED',
      OR: [
        { startDate: { gte: weekStart, lt: weekEnd } },
        { endDate: { gte: weekStart, lt: weekEnd } },
        {
          AND: [
            { startDate: { lt: weekStart } },
            { endDate: { gte: weekStart } },
          ],
        },
      ],
    },
    include: {
      leaveType: { select: { id: true, name: true } },
    },
  })

  // Build per-day data
  const days: Date[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    days.push(d)
  }

  // Group shifts by employeeId+date+clinicId
  const shiftsMap = new Map<string, any[]>()
  for (const s of shifts) {
    const dateKey = new Date(s.startTime).toISOString().slice(0, 10)
    const key = `${s.employeeId}::${dateKey}::${s.clinicId}`
    if (!shiftsMap.has(key)) shiftsMap.set(key, [])
    shiftsMap.get(key)!.push(s)
  }

  // Group leave by employeeId+date
  const leaveMap = new Map<string, { name: string }[]>()
  for (const lr of leaveRequests) {
    const start = new Date(lr.startDate)
    const end = new Date(lr.endDate)
    for (const day of days) {
      const dayMidnight = new Date(day.getFullYear(), day.getMonth(), day.getDate())
      if (dayMidnight >= start && dayMidnight <= end) {
        const dateKey = day.toISOString().slice(0, 10)
        const key = `${lr.employeeId}::${dateKey}`
        if (!leaveMap.has(key)) leaveMap.set(key, [])
        leaveMap.get(key)!.push({ name: lr.leaveType.name })
      }
    }
  }

  // Build response
  const employeeList = [...employees.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-HK'))

  const result = {
    weekStart: weekStartStr,
    days: days.map(d => d.toISOString().slice(0, 10)),
    currentUserId,
    employees: employeeList.map(emp => ({
      id: emp.id,
      userId: emp.userId,
      name: emp.name,
      clinics: emp.clinics,
      shifts: days.map(day => {
        const dateKey = day.toISOString().slice(0, 10)
        const shiftsForDay = emp.clinics.flatMap(c => {
          const key = `${emp.id}::${dateKey}::${c.id}`
          return shiftsMap.get(key) || []
        })
        const leaveForDay = leaveMap.get(`${emp.id}::${dateKey}`) || []

        return {
          date: dateKey,
          shifts: shiftsForDay.map(s => ({
            id: s.id,
            startTime: new Date(s.startTime).toISOString().slice(11, 16),
            endTime: new Date(s.endTime).toISOString().slice(11, 16),
            templateName: s.template?.name || '',
            clinicName: s.clinic?.name || '',
          })),
          leaves: leaveForDay.map(l => l.name),
        }
      }),
    })),
  }

  return NextResponse.json(result)
}
