export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr } from '@/lib/hk-date'
import { calculateTimeBank } from '@/lib/payroll-engine'

// GET /api/payroll-runs/exceptions — Attendance exceptions report + timebank summaries
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const employeeId = searchParams.get('employeeId')
  const periodMonth = searchParams.get('periodMonth')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')

  let monthStart: Date
  let monthEnd: Date

  if (startDate && endDate) {
    monthStart = new Date(startDate + 'T00:00:00+08:00')
    monthEnd = new Date(endDate + 'T23:59:59+08:00')
  } else if (periodMonth) {
    const [yearStr, monthStr] = periodMonth.split('-')
    monthStart = new Date(parseInt(yearStr), parseInt(monthStr) - 1, 1)
    monthEnd = new Date(parseInt(yearStr), parseInt(monthStr), 0, 23, 59, 59)
  } else {
    return NextResponse.json({ error: 'periodMonth (YYYY-MM) or startDate/endDate is required' }, { status: 400 })
  }

  const monthDate = monthStart

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
    date: string; type: 'LATE' | 'EARLY_LEAVE' | 'ABSENT' | 'CORRECTION' | 'OT';
    detail: string; punchTime?: string; correctionTime?: string;
    lateMinutes?: number; earlyMinutes?: number; otMinutes?: number;
    madeUp?: boolean;
  }> = []

  const clockIns = punches.filter(p => p.punchType === 'CLOCK_IN')
  const clockOuts = punches.filter(p => p.punchType === 'CLOCK_OUT')

  // Detect LATE from clock-in punches vs shift start
  for (const p of clockIns) {
    const punchDateStr = toHKDateStr(p.punchTime)
    const matchingShift = shifts.find(s =>
      s.employeeId === p.employeeId &&
      toHKDateStr(new Date(s.date)) === punchDateStr &&
      s.clinicId === p.clinicId
    )
    if (matchingShift) {
      const shiftStart = new Date(matchingShift.startTime)
      if (p.punchTime.getTime() > shiftStart.getTime()) {
        const lateMins = Math.ceil((p.punchTime.getTime() - shiftStart.getTime()) / 60000)
        if (lateMins > 0) {
          const clinic = p.employee?.clinics?.find(c => c.clinicId === p.clinicId)?.clinic
          exceptions.push({
            employeeId: p.employeeId, employeeName: p.employee?.user?.name || 'Unknown',
            clinicName: clinic?.name || p.clinicId,
            date: punchDateStr,
            type: 'LATE',
            lateMinutes: lateMins,
            detail: `遲到 ${lateMins} 分鐘 (排班 ${shiftStart.toLocaleTimeString('zh-HK')})`,
            punchTime: p.punchTime.toISOString(),
          })
        }
      }
    }
  }

  // Detect EARLY_LEAVE from clock-out punches vs shift end
  for (const p of clockOuts) {
    const punchDateStr = toHKDateStr(p.punchTime)
    const matchingShift = shifts.find(s =>
      s.employeeId === p.employeeId &&
      toHKDateStr(new Date(s.date)) === punchDateStr &&
      s.clinicId === p.clinicId
    )
    if (matchingShift) {
      const shiftEnd = new Date(matchingShift.endTime)
      if (p.punchTime.getTime() < shiftEnd.getTime()) {
        const earlyMins = Math.ceil((shiftEnd.getTime() - p.punchTime.getTime()) / 60000)
        if (earlyMins > 0) {
          const clinic = p.employee?.clinics?.find(c => c.clinicId === p.clinicId)?.clinic
          exceptions.push({
            employeeId: p.employeeId, employeeName: p.employee?.user?.name || 'Unknown',
            clinicName: clinic?.name || p.clinicId,
            date: punchDateStr,
            type: 'EARLY_LEAVE',
            earlyMinutes: earlyMins,
            detail: `早退 ${earlyMins} 分鐘 (${shiftEnd.toLocaleTimeString('zh-HK')})`,
            punchTime: p.punchTime.toISOString(),
          })
        }
      }
    }
  }

  // OT 偵測：下班晚於排班結束
  for (const p of clockOuts) {
    const punchDateStr = toHKDateStr(p.punchTime)
    const matchingShift = shifts.find(
      s =>
        s.employeeId === p.employeeId &&
        toHKDateStr(new Date(s.date)) === punchDateStr &&
        s.clinicId === p.clinicId
    )
    if (matchingShift) {
      const shiftEnd = new Date(matchingShift.endTime)
      if (p.punchTime.getTime() > shiftEnd.getTime()) {
        const otMins = Math.floor((p.punchTime.getTime() - shiftEnd.getTime()) / 60000)
        if (otMins > 0) {
          const clinic = p.employee?.clinics?.find(c => c.clinicId === p.clinicId)?.clinic
          exceptions.push({
            employeeId: p.employeeId, employeeName: p.employee?.user?.name || 'Unknown',
            clinicName: clinic?.name || p.clinicId,
            date: punchDateStr,
            type: 'OT',
            otMinutes: otMins,
            detail: `OT ${otMins} 分鐘`,
            punchTime: p.punchTime.toISOString(),
          })
        }
      }
    }
  }

  // Detect ABSENT from shifts with no punches
  for (const shift of shifts) {
    const shiftDayStr = toHKDateStr(new Date(shift.date))
    const hasPunch = punches.some(p =>
      p.employeeId === shift.employeeId &&
      toHKDateStr(p.punchTime) === shiftDayStr &&
      p.clinicId === shift.clinicId
    )
    if (!hasPunch) {
      exceptions.push({
        employeeId: shift.employeeId, employeeName: shift.employee?.user?.name || 'Unknown',
        clinicName: shift.clinic?.name || 'Unknown', date: shiftDayStr, type: 'ABSENT',
        detail: `排班但無打卡記錄 (${toHKDateStr(shift.startTime)})`,
      })
    }
  }

  for (const c of corrections) {
    const clinic = c.employee?.clinics?.find(cl => cl.clinicId === c.clinicId)?.clinic
    exceptions.push({
      employeeId: c.employeeId, employeeName: c.employee?.user?.name || 'Unknown',
      clinicName: clinic?.name || c.clinicId,
      date: toHKDateStr(c.correctedTime), type: 'CORRECTION',
      detail: `補登 ${c.punchType === 'CLOCK_IN' ? '上工' : '落班'} 至 ${c.correctedTime.toLocaleTimeString('zh-HK')}${c.reason ? ` (${c.reason})` : ''}`,
      correctionTime: c.correctedTime.toISOString(),
    })
  }

  // 抓補鐘記錄，標記 madeUp
  try {
    const empIds = [...new Set(exceptions.map(e => e.employeeId))]
    const makeupEntries = await prisma.timeBankEntry.findMany({
      where: {
        type: 'MAKEUP',
        date: { gte: monthStart, lte: monthEnd },
        employeeId: { in: empIds },
      },
    })
    const makeupSet = new Set(
      (makeupEntries || []).map((e: any) => `${e.employeeId}_${toHKDateStr(new Date(e.date))}`)
    )
    exceptions.forEach(ex => {
      ex.madeUp = makeupSet.has(`${ex.employeeId}_${ex.date}`)
    })
  } catch {}

  exceptions.sort((a, b) => b.date.localeCompare(a.date))

  // Compute per-employee timebank summaries — include ALL employees with punch/shift data (not just those with exceptions)
  const punchEmpIds = punches.map(p => p.employeeId)
  const shiftEmpIds = shifts.map(s => s.employeeId)
  let uniqueEmployeeIds = [...new Set([...punchEmpIds, ...shiftEmpIds, ...exceptions.map(e => e.employeeId)])]
  if (employeeId && !uniqueEmployeeIds.includes(employeeId)) {
    uniqueEmployeeIds.push(employeeId)
  }
  const employeeSummaries = await Promise.all(
    uniqueEmployeeIds.map(async (empId) => {
      const tb = await calculateTimeBank(empId, monthDate, {}, prisma)
      const emp = exceptions.find(e => e.employeeId === empId)
      return {
        employeeId: empId,
        employeeName: emp?.employeeName || 'Unknown',
        otMinutes: tb.otMinutes,
        owedMinutes: tb.owedMinutes,
        availableMinutes: tb.availableMinutes,
        convertibleLeaveDays: tb.convertibleLeaveDays,
        lateCount: exceptions.filter(e => e.employeeId === empId && e.type === 'LATE').length,
        lateMinutes: exceptions
          .filter(e => e.employeeId === empId && e.type === 'LATE')
          .reduce((s, e) => s + (e.lateMinutes || 0), 0),
        earlyLeaveCount: exceptions.filter(e => e.employeeId === empId && e.type === 'EARLY_LEAVE').length,
      }
    })
  )

  return NextResponse.json({
    exceptions,
    summaries: employeeSummaries,
    employeeSummaries,
    summary: {
      total: exceptions.length,
      late: exceptions.filter(e => e.type === 'LATE').length,
      absent: exceptions.filter(e => e.type === 'ABSENT').length,
      correction: exceptions.filter(e => e.type === 'CORRECTION').length,
      earlyLeave: exceptions.filter(e => e.type === 'EARLY_LEAVE').length,
    },
    periodMonth: periodMonth || undefined,
  })
}
