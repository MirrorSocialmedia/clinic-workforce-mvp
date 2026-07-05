import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/payroll-runs/_exceptions — Attendance exceptions report
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const employeeId = searchParams.get('employeeId')
  const periodMonth = searchParams.get('periodMonth')

  if (!periodMonth) {
    return NextResponse.json({ error: 'periodMonth (YYYY-MM) is required' }, { status: 400 })
  }

  const [yearStr, monthStr] = periodMonth.split('-')
  const monthStart = new Date(parseInt(yearStr), parseInt(monthStr) - 1, 1)
  const monthEnd = new Date(parseInt(yearStr), parseInt(monthStr), 0, 23, 59, 59)

  const punchWhere: any = { punchTime: { gte: monthStart, lte: monthEnd } }
  if (clinicId) punchWhere.clinicId = clinicId
  if (employeeId) punchWhere.employeeId = employeeId

  const punches = await prisma.punchRecord.findMany({
    where: punchWhere,
    include: {
      employee: {
        include: {
          user: { select: { name: true } },
          clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
        },
      },
    },
    orderBy: { punchTime: 'asc' },
  })

  const correctionWhere: any = {
    status: 'APPROVED',
    correctedTime: { gte: monthStart, lte: monthEnd },
  }
  if (clinicId) correctionWhere.clinicId = clinicId
  if (employeeId) correctionWhere.employeeId = employeeId

  const corrections = await prisma.punchCorrection.findMany({
    where: correctionWhere,
    include: {
      employee: {
        include: {
          user: { select: { name: true } },
          clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
        },
      },
    },
  })

  const shiftWhere: any = {
    date: { gte: monthStart, lte: monthEnd },
    status: 'CONFIRMED',
  }
  if (clinicId) shiftWhere.clinicId = clinicId
  if (employeeId) shiftWhere.employeeId = employeeId

  const shifts = await prisma.shift.findMany({
    where: shiftWhere,
    include: {
      employee: {
        include: {
          user: { select: { name: true } },
          clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
        },
      },
      clinic: { select: { id: true, name: true } },
    },
  })

  const exceptions: Array<{
    employeeId: string; employeeName: string; clinicName: string;
    date: string; type: 'LATE' | 'ABSENT' | 'CORRECTION';
    detail: string; punchTime?: string; correctionTime?: string
  }> = []

  const clockIns = punches.filter(p => p.punchType === 'CLOCK_IN')
  for (const p of clockIns) {
    const hour = p.punchTime.getHours()
    const minute = p.punchTime.getMinutes()
    const dow = p.punchTime.getDay()
    if (dow >= 1 && dow <= 5 && (hour > 9 || (hour === 9 && minute > 30))) {
      const clinic = p.employee.clinics.find(c => c.clinicId === p.clinicId)?.clinic
      exceptions.push({
        employeeId: p.employeeId, employeeName: p.employee.user.name,
        clinicName: clinic?.name || p.clinicId,
        date: p.punchTime.toISOString().split('T')[0],
        type: 'LATE',
        detail: `上班打卡 ${p.punchTime.toLocaleTimeString('zh-HK')} (超過 09:30)`,
        punchTime: p.punchTime.toISOString(),
      })
    }
  }

  for (const shift of shifts) {
    const shiftDayStr = new Date(shift.date).toISOString().split('T')[0]
    const hasPunch = punches.some(p =>
      p.employeeId === shift.employeeId &&
      p.punchTime.toISOString().split('T')[0] === shiftDayStr &&
      p.clinicId === shift.clinicId
    )
    if (!hasPunch) {
      exceptions.push({
        employeeId: shift.employeeId, employeeName: shift.employee.user.name,
        clinicName: shift.clinic.name, date: shiftDayStr, type: 'ABSENT',
        detail: `排班但無打卡記錄 (${shift.startTime.toISOString().split('T')[0]})`,
      })
    }
  }

  for (const c of corrections) {
    const clinic = c.employee.clinics.find(cl => cl.clinicId === c.clinicId)?.clinic
    exceptions.push({
      employeeId: c.employeeId, employeeName: c.employee.user.name,
      clinicName: clinic?.name || c.clinicId,
      date: c.correctedTime.toISOString().split('T')[0], type: 'CORRECTION',
      detail: `補登 ${c.punchType === 'CLOCK_IN' ? '上班' : '下班'} 至 ${c.correctedTime.toLocaleTimeString('zh-HK')}${c.reason ? ` (${c.reason})` : ''}`,
      correctionTime: c.correctedTime.toISOString(),
    })
  }

  exceptions.sort((a, b) => b.date.localeCompare(a.date))

  return NextResponse.json({
    exceptions,
    summary: {
      total: exceptions.length,
      late: exceptions.filter(e => e.type === 'LATE').length,
      absent: exceptions.filter(e => e.type === 'ABSENT').length,
      correction: exceptions.filter(e => e.type === 'CORRECTION').length,
    },
    periodMonth,
  })
}
