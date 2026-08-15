export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { todayHK, hkDateStart, toHKDateStr, getMonthRange } from '@/lib/hk-date'
import { matchPunchesToShifts, estimateScheduledHours } from '@/lib/shift-punch-match'
import { computeRosterHours } from '@/lib/roster-hours'

/** Get start/end of today in HK (UTC+8) */
function hkTodayBounds() {
  const start = hkDateStart(todayHK())
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  return { start, end }
}

// GET /api/dashboard — dashboard data based on role
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  let clinics: any[] = []

  if (scope === 'all') {
    clinics = await prisma.clinic.findMany({
      include: {
        _count: {
          select: {
            users: true,
            employees: true,
            shifts: true,
            punches: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })
  } else {
    clinics = await prisma.clinic.findMany({
      where: { id: { in: session.clinics ?? [] } },
      include: {
        _count: {
          select: {
            users: true,
            employees: true,
            shifts: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })
  }

  // ── Today's daily stats per clinic ──
  const { start: todayStart, end: todayEnd } = hkTodayBounds()

  const todayStats = await Promise.all(clinics.map(async (clinic) => {
    // 1. Scheduled shifts today (non-cancelled)
    const scheduled = await prisma.shift.count({
      where: {
        clinicId: clinic.id,
        date: { gte: todayStart, lt: todayEnd },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
      },
    })

    // 2. Employee IDs who have a scheduled shift today
    const scheduledEmployees = await prisma.shift.findMany({
      where: {
        clinicId: clinic.id,
        date: { gte: todayStart, lt: todayEnd },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
      },
      select: { id: true, employeeId: true, startTime: true, endTime: true, clinicId: true, secondaryClinicId: true, date: true, status: true },
    })

    const employeeIds = scheduledEmployees.map((s) => s.employeeId)

    // 3. CLOCK_IN records today at this clinic for scheduled employees
    const punchRecords =
      employeeIds.length > 0
        ? await prisma.punchRecord.findMany({
            where: {
              clinicId: clinic.id,
              employeeId: { in: employeeIds },
              punchTime: { gte: todayStart, lt: todayEnd },
              void: { is: null }, // 已作廢的不算
            },
            select: { employeeId: true, punchTime: true, punchType: true, clinicId: true },
          })
        : []

    const clockedInSet = new Set(punchRecords.filter(p => p.punchType === 'CLOCK_IN').map((p) => p.employeeId))
    const clockedIn = clockedInSet.size

    // ★ 用共用配對邏輯（唔再用 Map(employeeId → 第一張更)）
    const matched = matchPunchesToShifts(
      scheduledEmployees,
      punchRecords.map(p => ({
        effectiveTime: p.punchTime,
        punchType: p.punchType,
        clinicId: p.clinicId,
      })),
    )
    const late = matched.filter(m => m.lateMinutes > 0).length

    return {
      clinicId: clinic.id,
      clinicName: clinic.name,
      scheduled,
      clockedIn,
      late,
      notArrived: scheduled - clockedIn,
    }
  }))

  // Attach todayStats to each clinic object
  const clinicsWithStats = clinics.map((clinic) => ({
    ...clinic,
    todayStats: todayStats.find((s) => s.clinicId === clinic.id) ?? null,
  }))

  // Get recent audit logs for non-EMPLOYEE
  let recentAuditLogs: any[] = []
  if (scope !== 'self') {
    const where: any = {}
    const sessionClinics = session.clinics ?? []
    if (scope === 'my-clinics' && sessionClinics.length > 0) {
      where.clinicId = { in: sessionClinics }
    }
    recentAuditLogs = await prisma.auditLog.findMany({
      where,
      include: { actor: { select: { name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
  }

  // Count distinct employees across all clinics (not EmployeeClinic bindings)
  const allEmployeeClinics = await prisma.employeeClinic.findMany({
    where: {
      clinicId: { in: clinics.map(c => c.id) },
    },
    select: { employeeId: true },
  })
  const distinctEmployeeCount = new Set(allEmployeeClinics.map(ec => ec.employeeId)).size

  // ── Work hours: current week (Mon–Sun) + current month ──
  // ★ 唔好用 toLocaleString 造假 Date —— getFullYear() 等會攞到 UTC 解讀的假時間，
  //   再用 new Date(y,m,1) 建構就變咗 UTC 午夜，同 HK 月初差 8 小時。
  //   統一用 hk-date helper。
  const todayHKDate = toHKDateStr(new Date()) // 'YYYY-MM-DD'
  const { start: monthStart, end: monthEnd } = getMonthRange(hkDateStart(todayHKDate))

  const dow = new Date(`${todayHKDate}T12:00:00+08:00`).getUTCDay() // 中午取 dow，避免邊界
  const monOff = dow === 0 ? -6 : 1 - dow
  const weekStartStr = toHKDateStr(new Date(hkDateStart(todayHKDate).getTime() + monOff * 86400000))
  const weekStart = hkDateStart(weekStartStr)
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000)

  const activeEmployees = await prisma.employee.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      homeClinicId: true,
      user: { select: { name: true } },
      homeClinic: { select: { id: true, name: true } },
      payRules: { where: { isActive: true }, select: { payType: true, configJson: true }, take: 1 },
    },
  })

  // ── Work hours data only — empSummary removed (frontend uses /api/payroll-runs/exceptions) ──

  const monthShifts = await prisma.shift.findMany({
    where: { status: { not: 'CANCELLED' }, date: { gte: monthStart, lt: monthEnd } },
    select: {
      employeeId: true, startTime: true, endTime: true, date: true,
      template: { select: { deductLunch: true } },  // ★ 唔加呢行，dashboard 永遠 flat 60
    },
  })

  // ★ 午飯扣減讀 config，唔寫死 1 小時
  const lunchMinutesMap = new Map<string, number>()
  for (const emp of activeEmployees) {
    try {
      const cfg = JSON.parse(emp.payRules?.[0]?.configJson || '{}')
      lunchMinutesMap.set(emp.id, cfg?.modifiers?.lunch_break?.defaultMinutes ?? 60)
    } catch {
      lunchMinutesMap.set(emp.id, 60)
    }
  }

  const estimated = estimateScheduledHours(monthShifts, (empId) => lunchMinutesMap.get(empId) ?? 60)

  // ★ 應返工時（只計月薪員工）— 傳入已有 shifts + lunchMinutes 避免重複查詢
  const monthlyEmpIds = activeEmployees
    .filter(e => e.payRules?.[0]?.payType === 'MONTHLY')
    .map(e => e.id)
  const rh = await computeRosterHours(monthlyEmpIds, toHKDateStr(new Date()).slice(0, 7), prisma, {
    shifts: monthShifts,
    lunchMinutes: lunchMinutesMap,
  })

  const workHours = activeEmployees.map(emp => {
    const empDays = estimated.get(emp.id) ?? []
    let weekH = 0
    let monthH = 0
    for (const d of empDays) {
      const dt = new Date(d.date + 'T12:00:00+08:00')
      monthH += d.hours
      if (dt >= weekStart && dt < weekEnd) weekH += d.hours
    }
    const r = rh.get(emp.id)
    return {
      employeeId: emp.id,
      name: emp.user?.name ?? '?',
      clinicId: emp.homeClinicId ?? emp.homeClinic?.id ?? null,
      clinicName: emp.homeClinic?.name ?? '',
      weekHours: Math.round(weekH * 10) / 10,
      monthHours: Math.round(monthH * 10) / 10,
      weekOvertime: weekH > 45,
      expectedMinutes: r?.expectedMinutes ?? null,
      rosterDiffMinutes: r?.diffMinutes ?? null,
    }
  }).sort((a, b) => b.weekHours - a.weekHours)

  // Distinct clinic options from workHours
  const clinicMap = new Map<string, { clinicId: string; clinicName: string }>()
  for (const wh of workHours) {
    if (wh.clinicId && !clinicMap.has(wh.clinicId)) {
      clinicMap.set(wh.clinicId, { clinicId: wh.clinicId, clinicName: wh.clinicName })
    }
  }
  const whClinics = [...clinicMap.values()]

  return NextResponse.json({
    role: session.role,
    clinics: clinicsWithStats,
    recentAuditLogs,
    distinctEmployeeCount,
    workHours,
    whClinics: whClinics,
  })
}
