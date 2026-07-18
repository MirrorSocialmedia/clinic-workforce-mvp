export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr, fmtTime } from '@/lib/hk-date'
import { calculateTimeBank } from '@/lib/payroll-engine'
import { getEffectivePunches } from '@/lib/punch-query'

// GET /api/payroll-runs/exceptions — Attendance exceptions report + timebank summaries
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
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

  // Fix #2a: Get all HOURLY employee IDs to skip them
  const hourlyEmpIds = new Set(
    (await prisma.payRule.findMany({
      where: { isActive: true, payType: 'HOURLY' },
      select: { employeeId: true },
    })).map(r => r.employeeId)
  )

  const effectivePunches = await getEffectivePunches(monthStart, monthEnd, {
    clinicId: clinicId || undefined,
    employeeId: employeeId || undefined,
  })

  // Build employee lookup for raw punch employee data (needed for display)
  const rawPunches = await prisma.punchRecord.findMany({
    where: {
      punchTime: { gte: monthStart, lte: monthEnd },
      void: { is: null },
      ...(clinicId ? { clinicId } : {}),
      ...(employeeId ? { employeeId } : {}),
    },
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

  // Map raw punches by raw punch key for employee info lookup
  const rawByTime = new Map<string, typeof rawPunches[0]>()
  for (const rp of rawPunches) {
    const k = `${toHKDateStr(rp.punchTime)}:${rp.clinicId}:${rp.employeeId}:${rp.punchType}`
    rawByTime.set(k, rp)
  }

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
    payType?: 'HOURLY' | 'MONTHLY';
    // ABSENT-specific fields
    otDeducted?: boolean;
    shiftMinutes?: number;
  }> = []

  // Build employee info map from raw punches for display names
  const empInfo = new Map<string, { name: string; clinics: Array<{ clinicId: string; clinicName: string }> }>()
  for (const rp of rawPunches) {
    const existing = empInfo.get(rp.employeeId)
    if (!existing) {
      empInfo.set(rp.employeeId, {
        name: rp.employee?.user?.name || 'Unknown',
        clinics: rp.employee?.clinics?.map(c => ({ clinicId: c.clinicId, clinicName: c.clinic?.name || c.clinicId })) || [],
      })
    }
  }

  const clockIns = effectivePunches.filter(ep => ep.punchType === 'CLOCK_IN')
  const clockOuts = effectivePunches.filter(ep => ep.punchType === 'CLOCK_OUT')

  // Helper: get employee info for a given employeeId
  function getEmpInfo(eid: string) {
    return empInfo.get(eid) || { name: 'Unknown', clinics: [] }
  }
  function getClinicName(eid: string, cid: string) {
    return getEmpInfo(eid).clinics.find(c => c.clinicId === cid)?.clinicName || cid
  }

  // Detect LATE from effective clock-in punches vs shift start
  for (const ep of clockIns) {
    const punchDateStr = toHKDateStr(ep.effectiveTime)
    const matchingShift = shifts.find(s =>
      s.employeeId === ep.raw.employeeId &&
      toHKDateStr(new Date(s.date)) === punchDateStr &&
      s.clinicId === ep.clinicId
    )
    if (matchingShift) {
      const shiftStart = new Date(matchingShift.startTime)
      if (ep.effectiveTime.getTime() > shiftStart.getTime()) {
        const lateMins = Math.ceil((ep.effectiveTime.getTime() - shiftStart.getTime()) / 60000)
        if (lateMins > 0) {
          exceptions.push({
            employeeId: ep.raw.employeeId, employeeName: getEmpInfo(ep.raw.employeeId).name,
            clinicName: getClinicName(ep.raw.employeeId, ep.clinicId),
            date: punchDateStr,
            type: 'LATE',
            lateMinutes: lateMins,
            detail: `遲到 ${lateMins} 分鐘 (排班 ${fmtTime(shiftStart.toISOString())})`,
            punchTime: ep.effectiveTime.toISOString(),
          })
        }
      }
    }
  }

  // Detect EARLY_LEAVE from effective clock-out punches vs shift end
  for (const ep of clockOuts) {
    const punchDateStr = toHKDateStr(ep.effectiveTime)
    const matchingShift = shifts.find(s =>
      s.employeeId === ep.raw.employeeId &&
      toHKDateStr(new Date(s.date)) === punchDateStr &&
      s.clinicId === ep.clinicId
    )
    if (matchingShift) {
      const shiftEnd = new Date(matchingShift.endTime)
      if (ep.effectiveTime.getTime() < shiftEnd.getTime()) {
        const earlyMins = Math.ceil((shiftEnd.getTime() - ep.effectiveTime.getTime()) / 60000)
        if (earlyMins > 0) {
          exceptions.push({
            employeeId: ep.raw.employeeId, employeeName: getEmpInfo(ep.raw.employeeId).name,
            clinicName: getClinicName(ep.raw.employeeId, ep.clinicId),
            date: punchDateStr,
            type: 'EARLY_LEAVE',
            earlyMinutes: earlyMins,
            detail: `早退 ${earlyMins} 分鐘 (${fmtTime(shiftEnd.toISOString())})`,
            punchTime: ep.effectiveTime.toISOString(),
          })
        }
      }
    }
  }

  // Batch query OT thresholds from payRules (avoids N+1)
  const uniquePunchEmpIds = [...new Set(effectivePunches.map(ep => ep.raw.employeeId))]
  const rules = await prisma.payRule.findMany({
    where: {
      employeeId: { in: uniquePunchEmpIds },
      isActive: true,
      effectiveFrom: { lte: monthEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })
  const otMinByEmp = new Map<string, number>()
  for (const r of rules) {
    if (otMinByEmp.has(r.employeeId)) continue
    try {
      const cfg = JSON.parse(r.configJson as any)
      otMinByEmp.set(r.employeeId, cfg?.modifiers?.overtime?.ot_min_minutes ?? 0)
    } catch {
      otMinByEmp.set(r.employeeId, 0)
    }
  }

  // OT 偵測：下班晚於排班結束 (use effectiveTime) — with per-day threshold
  for (const ep of clockOuts) {
    const punchDateStr = toHKDateStr(ep.effectiveTime)
    const matchingShift = shifts.find(
      s =>
        s.employeeId === ep.raw.employeeId &&
        toHKDateStr(new Date(s.date)) === punchDateStr &&
        s.clinicId === ep.clinicId
    )
    if (matchingShift) {
      const shiftEnd = new Date(matchingShift.endTime)
      if (ep.effectiveTime.getTime() > shiftEnd.getTime()) {
        const otMins = Math.floor((ep.effectiveTime.getTime() - shiftEnd.getTime()) / 60000)
        const minReq = otMinByEmp.get(ep.raw.employeeId) ?? 0
        if (otMins > 0 && otMins >= minReq) {
          exceptions.push({
            employeeId: ep.raw.employeeId, employeeName: getEmpInfo(ep.raw.employeeId).name,
            clinicName: getClinicName(ep.raw.employeeId, ep.clinicId),
            date: punchDateStr,
            type: 'OT',
            otMinutes: otMins,
            detail: `OT ${otMins} 分鐘`,
            punchTime: ep.effectiveTime.toISOString(),
          })
        }
      }
    }
  }

  // Detect ABSENT from shifts with no effective punches
  for (const shift of shifts) {
    const shiftDayStr = toHKDateStr(new Date(shift.date))
    const hasPunch = effectivePunches.some(ep =>
      ep.raw.employeeId === shift.employeeId &&
      toHKDateStr(ep.effectiveTime) === shiftDayStr &&
      ep.clinicId === shift.clinicId
    )
    if (!hasPunch) {
      const shiftStart = shift.startTime instanceof Date ? shift.startTime : new Date(shift.startTime)
      const shiftEnd = shift.endTime instanceof Date ? shift.endTime : new Date(shift.endTime)
      const shiftMinutes = Math.round((shiftEnd.getTime() - shiftStart.getTime()) / 60000)
      exceptions.push({
        employeeId: shift.employeeId, employeeName: shift.employee?.user?.name || 'Unknown',
        clinicName: shift.clinic?.name || 'Unknown', date: shiftDayStr, type: 'ABSENT',
        detail: `排班但無打卡記錄 (${toHKDateStr(shift.startTime)})`,
        shiftMinutes,
      })
    }
  }

  // 查詢 ABSENT 類型的扣OT鐘記錄（標記 otDeducted）
  try {
    const absentEmpIds = [...new Set(exceptions.filter(e => e.type === 'ABSENT').map(e => e.employeeId))]
    if (absentEmpIds.length > 0) {
      const absentEntries = await prisma.timeBankEntry.findMany({
        where: {
          type: 'MAKEUP',
          targetType: 'ABSENT',
          date: { gte: monthStart, lte: monthEnd },
          employeeId: { in: absentEmpIds },
        },
      })
      const absentSet = new Map<string, number>()
      for (const e of absentEntries) {
        absentSet.set(`${e.employeeId}_${toHKDateStr(new Date(e.date))}`, Math.abs(e.minutes))
      }
      exceptions.forEach(ex => {
        if (ex.type === 'ABSENT') {
          const key = `${ex.employeeId}_${ex.date}`
          if (absentSet.has(key)) {
            ex.otDeducted = true
            ex.shiftMinutes = absentSet.get(key)!
          } else {
            ex.otDeducted = false
          }
        }
      })
    }
  } catch {
    // timeBankEntry may not exist
  }

  for (const c of corrections) {
    const clinic = c.employee?.clinics?.find(cl => cl.clinicId === c.clinicId)?.clinic
    exceptions.push({
      employeeId: c.employeeId, employeeName: c.employee?.user?.name || 'Unknown',
      clinicName: clinic?.name || c.clinicId,
      date: toHKDateStr(c.correctedTime), type: 'CORRECTION',
      detail: `補登 ${c.punchType === 'CLOCK_IN' ? '上工' : '落班'} 至 ${fmtTime(c.correctedTime)}${c.reason ? ` (${c.reason})` : ''}`,
      correctionTime: c.correctedTime.toISOString(),
    })
  }

  // 抓補鐘記錄，標記 madeUp（按日期+類型，避免連坐）
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
      (makeupEntries || []).map((e: any) => `${e.employeeId}_${toHKDateStr(new Date(e.date))}_${e.targetType}`)
    )
    exceptions.forEach(ex => {
      if (ex.type === 'LATE' || ex.type === 'EARLY_LEAVE') {
        ex.madeUp = makeupSet.has(`${ex.employeeId}_${ex.date}_${ex.type}`)
      }
    })
  } catch {}

  // Set payType on all exceptions
  exceptions.forEach(ex => {
    ex.payType = hourlyEmpIds.has(ex.employeeId) ? 'HOURLY' : 'MONTHLY'
  })

  exceptions.sort((a, b) => b.date.localeCompare(a.date))

  // Compute per-employee timebank summaries — include ALL employees with punch/shift data (not just those with exceptions)
  const punchEmpIds = rawPunches.map(p => p.employeeId)
  const shiftEmpIds = shifts.map(s => s.employeeId)
  let uniqueEmployeeIds = [...new Set([...punchEmpIds, ...shiftEmpIds, ...exceptions.map(e => e.employeeId)])]
  if (employeeId && !uniqueEmployeeIds.includes(employeeId)) {
    uniqueEmployeeIds.push(employeeId)
  }
  // Fix #2a: excluded HOURLY from exception detection; keep them in summaries with payType
  const empPayRules = await prisma.payRule.findMany({
    where: {
      isActive: true,
      employeeId: { in: uniqueEmployeeIds },
    },
    select: { employeeId: true, payType: true },
  })
  const payTypeMap = new Map(empPayRules.map(r => [r.employeeId, r.payType]))

  const employeeSummaries = await Promise.all(
    uniqueEmployeeIds.map(async (empId) => {
      const isHourly = (payTypeMap.get(empId) || 'MONTHLY') === 'HOURLY'
      const tb = await calculateTimeBank(empId, monthDate, {}, prisma)
      const emp = exceptions.find(e => e.employeeId === empId)
      return {
        employeeId: empId,
        employeeName: emp?.employeeName || 'Unknown',
        payType: payTypeMap.get(empId) || 'MONTHLY',
        timeAccountMinutes: isHourly ? null : (tb.timeAccountMinutes ?? (tb.availableMinutes - tb.owedMinutes)),
        otMinutes: tb.otMinutes,
        owedMinutes: isHourly ? null : tb.owedMinutes,
        availableMinutes: isHourly ? null : tb.availableMinutes,
        convertibleLeaveDays: isHourly ? null : tb.convertibleLeaveDays,
        lateCount: exceptions.filter(e => e.employeeId === empId && e.type === 'LATE').length,
        lateMinutes: exceptions
          .filter(e => e.employeeId === empId && e.type === 'LATE')
          .reduce((s, e) => s + (e.lateMinutes || 0), 0),
        otCount: exceptions.filter(e => e.employeeId === empId && e.type === 'OT').length,
        makeupMinutes: isHourly ? null : tb.makeupMinutes,
        earlyLeaveCount: exceptions.filter(e => e.employeeId === empId && e.type === 'EARLY_LEAVE').length,
        netEarlyMinutes: isHourly ? null : tb.netEarlyMinutes,
        earlyLeaveMinutes: exceptions
          .filter(e => e.employeeId === empId && e.type === 'EARLY_LEAVE')
          .reduce((s, e) => s + (e.earlyMinutes || 0), 0),
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
