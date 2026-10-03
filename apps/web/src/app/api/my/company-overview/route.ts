export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr, fmtTime, leaveCoversDate } from '@/lib/hk-date'
import { employedFromWhere } from '@/lib/employment-scope'

// ============================================================
// GET /api/my/company-overview — Company-wide schedule overview for a week / month
// All roles. Uses employee's clinics → company → all clinics in company.
// Query: ?weekStart=2026-07-13  或  ?month=2026-10（★ cwm-mobilemonth-20261003：手機整月總覽，同電腦版月視圖）
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { searchParams } = new URL(req.url)
  const monthStr = searchParams.get('month')
  const weekStartStr = monthStr ? `${monthStr}-01` : searchParams.get('weekStart')
  if (monthStr && !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthStr)) {
    return NextResponse.json({ error: 'month 格式要 YYYY-MM' }, { status: 400 })
  }
  if (!weekStartStr || !/^\d{4}-\d{2}-\d{2}$/.test(weekStartStr)) {
    return NextResponse.json({ error: 'weekStart is required (YYYY-MM-DD)' }, { status: 400 })
  }

  // ★ 變數名沿用 weekStart/weekEnd（週模式）；月模式 = 該月 1 號 → 下月 1 號（HK）
  const weekStart = new Date(weekStartStr + 'T00:00:00+08:00')
  const weekEnd = new Date(weekStart)
  if (monthStr) {
    const [y, m] = monthStr.split('-').map(Number)
    weekEnd.setTime(new Date(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T00:00:00+08:00`).getTime())
  } else {
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7)
  }
  const dayCount = Math.round((weekEnd.getTime() - weekStart.getTime()) / 86400000)

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
  // ★ cwm-resignsweep-20261003：已離職員工只喺呢段期間（週／月）仲有返工日先出現（離職之後撤走空行）
  const allEmployeeClinics = await prisma.employeeClinic.findMany({
    where: { clinicId: { in: allClinicIds }, employee: employedFromWhere(weekStart) },
    include: {
      employee: {
        include: {
          user: { select: { id: true, name: true } },
          // ★ cwm-mobilemonth-20261003：全職／兼職分組（同電腦版月視圖：HOURLY = 兼職）
          payRules: { where: { isActive: true }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }], take: 1, select: { payType: true } },
        },
      },
    },
  })

  const employees = new Map<string, {
    id: string
    userId: string
    name: string
    clinics: { id: string; name: string }[]
    partTime: boolean
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
        partTime: emp.payRules?.[0]?.payType === 'HOURLY',
      })
    }
    employees.get(key)!.clinics.push({ id: ec.clinicId, name: '' })
  }

  // Attach clinic names
  const clinicNameMap = new Map<string, string>(allClinics.map(c => [c.id, c.name]))
  for (const emp of employees.values()) {
    emp.clinics = emp.clinics.map(c => ({ id: c.id, name: clinicNameMap.get(c.id) || '' }))
  }

  const employeeIds = [...employees.keys()]
  const currentUserId = session.userId

  // 4. Get shifts for the week for all these employees
  const shifts = await prisma.shift.findMany({
    where: {
      employeeId: { in: employeeIds },
      // ★ cwm-consist S6 DB-12：取消咗嘅更唔應該出現喺公司總覽
      status: { not: 'CANCELLED' },
      OR: [
        { clinicId: { in: allClinicIds } },
        { secondaryClinicId: { in: allClinicIds } },
      ],
      startTime: { gte: weekStart, lt: weekEnd },
    },
    include: {
      clinic: { select: { id: true, name: true, shortName: true } },
      template: { select: { id: true, name: true, shortName: true } },
    },
  })

  // ★ 調鋪嘅第二診所名（同 my/schedule/route.ts 一致）
  const secIds = [...new Set(shifts.map(s => s.secondaryClinicId).filter((v): v is string => !!v))]
  const secMap = new Map<string, { name: string; shortName: string | null }>()
  if (secIds.length > 0) {
    const secs = await prisma.clinic.findMany({
      where: { id: { in: secIds } },
      select: { id: true, name: true, shortName: true },
    })
    for (const c of secs) secMap.set(c.id, { name: c.name, shortName: c.shortName })
  }

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
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(weekStart)
    d.setUTCDate(d.getUTCDate() + i)
    days.push(d)
  }

  // Group shifts by employeeId+date
  // ★ cwm-mobilemonth-20261003：唔再按員工「已綁定診所」過濾 —— 臨時去未綁定嘅店返工（電腦版照顯示）
  //   之前會喺手機總覽靜靜消失。shifts 已經收窄到本公司診所。
  const shiftsMap = new Map<string, any[]>()
  for (const s of shifts) {
    const dateKey = toHKDateStr(new Date(s.startTime))
    const key = `${s.employeeId}::${dateKey}`
    if (!shiftsMap.has(key)) shiftsMap.set(key, [])
    shiftsMap.get(key)!.push(s)
  }

  // Group leave by employeeId+date
  const leaveMap = new Map<string, { name: string }[]>()
  for (const lr of leaveRequests) {
    for (const day of days) {
      const dateKey = toHKDateStr(day)
      if (leaveCoversDate(lr, dateKey)) {
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
    ...(monthStr ? { month: monthStr } : {}),
    days: days.map(d => toHKDateStr(d)),
    currentUserId,
    employees: employeeList.map(emp => ({
      id: emp.id,
      userId: emp.userId,
      name: emp.name,
      clinics: emp.clinics,
      partTime: emp.partTime,
      shifts: days.map(day => {
        const dateKey = toHKDateStr(day)
        const shiftsForDay = [...(shiftsMap.get(`${emp.id}::${dateKey}`) || [])]
          .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
        const leaveForDay = leaveMap.get(`${emp.id}::${dateKey}`) || []

        return {
          date: dateKey,
          shifts: shiftsForDay.map(s => {
            const sec = s.secondaryClinicId ? secMap.get(s.secondaryClinicId) : null
            return {
              id: s.id,
              startTime: fmtTime(s.startTime),
              endTime: fmtTime(s.endTime),
              templateName: s.template?.name || '',
              templateShortName: s.template?.shortName || s.template?.name || '',
              clinicName: s.clinic?.name || '',
              clinicShortName: s.clinic?.shortName || s.clinic?.name || '',
              secondaryClinicName: sec?.name ?? null,
              secondaryClinicShortName: sec?.shortName || sec?.name || null,
              isTransfer: !!s.secondaryClinicId,
            }
          }),
          leaves: leaveForDay.map(l => l.name),
        }
      }),
    })),
  }

  return NextResponse.json(result)
}
