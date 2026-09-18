export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { todayHK, hkDateStart, toHKDateStr, getMonthRange } from '@/lib/hk-date'
import { estimateScheduledHours } from '@/lib/shift-punch-match'
import { buildTodayBoard } from '@/lib/today-board'
import { computeRosterHours, rosterDiffNoteFilter } from '@/lib/roster-hours'

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
  const { session, scope, perms } = auth

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

  // ★ cwm-ownerdash-20260917：今日出勤看板（有時間感知；名單只俾管理層）
  const canSeePeople = session.role === 'OWNER' || session.role === 'MANAGER' || (perms ?? []).includes('attendance_manage') // ROLE-OK: 同事出勤名單
  const todayStats = await Promise.all(clinics.map(async (clinic) => {
    const b = await buildTodayBoard(clinic.id, todayStart, todayEnd)
    return {
      clinicId: clinic.id, clinicName: clinic.name,
      scheduled: b.scheduled, expected: b.expected, clockedIn: b.clockedIn,
      late: b.late, notArrived: b.notArrived, notStarted: b.notStarted,
      missingOut: b.missingOut, onLeaveCount: b.onLeaveCount,
      ...(canSeePeople ? { people: b.people, onLeave: b.onLeave } : {}),
    }
  }))

  // Attach todayStats to each clinic object
  const clinicsWithStats = clinics.map((clinic) => ({
    ...clinic,
    todayStats: todayStats.find((s) => s.clinicId === clinic.id) ?? null,
  }))

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
    where: {
      status: 'ACTIVE',
      // ★ cwm-attexempt-20260914 C2：免考勤員工（會計）唔喺工時概覽（同 api/roster-hours 口徑）
      attendanceExempt: false,
    },
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
      template: { select: { deductLunch: true } },
      status: true, // ★ estimateScheduledHours 會 check s.status === 'CANCELLED'
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
  const currentMonth = toHKDateStr(new Date()).slice(0, 7)
  const monthlyEmpIds = activeEmployees
    .filter(e => e.payRules?.[0]?.payType === 'MONTHLY')
    .map(e => e.id)
  const rh = await computeRosterHours(monthlyEmpIds, currentMonth, prisma, {
    shifts: monthShifts,
    lunchMinutes: lunchMinutesMap,
  })

  // ★ 讀 settled entries —— 同 api/roster-hours 同 api/my/roster-hours 口徑一致
  const settledRows = await prisma.timeBankEntry.findMany({
    where: {
      employeeId: { in: monthlyEmpIds },
      type: 'ROSTER_DIFF',
      note: rosterDiffNoteFilter(currentMonth),
    },
    select: { employeeId: true, minutes: true },
  })
  const settledMap = new Map(settledRows.map(s => [s.employeeId, s.minutes]))

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
    const settled = r ? settledMap.get(emp.id) : null
    return {
      employeeId: emp.id,
      name: emp.user?.name ?? '?',
      clinicId: emp.homeClinicId ?? emp.homeClinic?.id ?? null,
      clinicName: emp.homeClinic?.name ?? '',
      weekHours: Math.round(weekH * 10) / 10,
      monthHours: Math.round(monthH * 10) / 10,
      weekOvertime: weekH > 45,
      expectedMinutes: r?.expectedMinutes ?? null,
      rosterDiffMinutes: r ? (settled != null ? settled : r.diffMinutes) : null,
      settled: r ? settled != null : false,
      unscheduled: r ? (settled != null ? false : r.unscheduled) : false,
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
    distinctEmployeeCount,
    workHours,
    whClinics: whClinics,
    updatedAt: new Date().toISOString(),
  })
}
