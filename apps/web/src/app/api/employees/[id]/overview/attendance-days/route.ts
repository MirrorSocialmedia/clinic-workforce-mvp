export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope, canSeeConfidential } from '@/lib/scope-helpers'
import { hkDateStart, hkDateEnd, toHKDateStr, leaveCoversDate } from '@/lib/hk-date'
import { diffMinutes } from '@/lib/shift-punch-match'

// GET /api/employees/[id]/overview/attendance-days
// ?from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&pageSize=20
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const emp = await prisma.employee.findUnique({ where: { id: params.id } })
  if (!emp) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  // Same scope + confidential check as overview route
  const allowed = await resolveClinicScope(session, auth.perms ?? [], {
    homeOnly: ['employee_overview'],
  })
  if (allowed !== null && emp.homeClinicId && !allowed.includes(emp.homeClinicId)) {
    return NextResponse.json({ error: '只可以查看主屬診所嘅員工' }, { status: 403 })
  }
  if (!(await canSeeConfidential(session, auth.perms ?? [], emp))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const from = url.searchParams.get('from') || undefined
  const to = url.searchParams.get('to') || undefined
  const page = parseInt(url.searchParams.get('page') || '1')
  const pageSize = parseInt(url.searchParams.get('pageSize') || '20')

  // Default: last 20 punch days (no from/to)
  const dateFrom = from ? hkDateStart(from) : undefined
  const dateTo = to ? hkDateEnd(to) : undefined

  // Fetch punch records grouped by day
  const punches = await prisma.punchRecord.findMany({
    where: {
      employeeId: emp.id,
      punchTime: {
        gte: dateFrom,
        lte: dateTo,
      },
      punchType: { in: ['CLOCK_IN', 'CLOCK_OUT'] },
      void: { is: null },
    },
    orderBy: { punchTime: 'desc' },
    include: {
      clinic: { select: { name: true, shortName: true } },
    },
  })

  // ★ B1: Fetch shifts for late/early/OT computation
  const shifts = await prisma.shift.findMany({
    where: {
      employeeId: emp.id,
      status: { not: 'CANCELLED' },
      date: {
        gte: dateFrom,
        lte: dateTo,
      },
    },
    select: {
      id: true,
      date: true,
      startTime: true,
      endTime: true,
      clinicId: true,
      secondaryClinicId: true,
    },
  })

  // ★ 2026-08-28：冇更表日「假期返工 OT」需要核對當日用 APPROVED 假期記錄
  //   （同 payroll-engine no-shift 分支 hasLeave 一致 —— 淨係漏排更嘅日唔可當 OT）
  const leaves = await prisma.leaveRequest.findMany({
    where: {
      employeeId: emp.id,
      status: 'APPROVED',
      ...(dateTo ? { startDate: { lte: dateTo } } : {}),
      ...(dateFrom ? { endDate: { gte: dateFrom } } : {}),
    },
  })

  // Group by HK date, pair in/out
  const dayMap = new Map<string, any>()
  for (const p of punches) {
    const day = toHKDateStr(p.punchTime)
    if (!dayMap.has(day)) {
      dayMap.set(day, {
        date: day,
        clinicName: p.clinic?.name || '—',
        firstIn: null,
        lastOut: null,
        punchIds: [],
      })
    }
    const entry = dayMap.get(day)
    entry.punchIds.push(p.id)
    if (p.punchType === 'CLOCK_IN') {
      if (!entry.firstIn || p.punchTime < entry.firstIn) {
        entry.firstIn = p.punchTime
      }
    } else if (p.punchType === 'CLOCK_OUT') {
      if (!entry.lastOut || p.punchTime > entry.lastOut) {
        entry.lastOut = p.punchTime
      }
    }
  }

  // ★ B1: Build shift lookup by date for late/early/OT computation
  const shiftByDate = new Map<string, typeof shifts>()
  for (const s of shifts) {
    const day = toHKDateStr(new Date(s.date))
    if (!shiftByDate.has(day)) shiftByDate.set(day, [])
    shiftByDate.get(day)!.push(s)
  }

  const days = Array.from(dayMap.values())
    .map(d => {
      let workedMinutes = null
      let lateMin = 0
      let earlyMin = 0
      let otMin = 0

      if (d.firstIn && d.lastOut) {
        workedMinutes = Math.round((d.lastOut - d.firstIn) / 60000)
      }

      // ★ B1: Match against shift for late/early/OT
      const dayShifts = shiftByDate.get(d.date)
      if (dayShifts) {
        // Find the shift that matches this day's clinic
        const clinicPunch = punches.find(p => toHKDateStr(p.punchTime) === d.date)
        const matchingShift = dayShifts.find(s =>
          s.clinicId === clinicPunch?.clinicId || s.secondaryClinicId === clinicPunch?.clinicId
        ) || dayShifts[0]
        if (matchingShift) {
          const sStart = new Date(matchingShift.startTime)
          const sEnd = new Date(matchingShift.endTime)
          // Late
          if (d.firstIn && d.firstIn.getTime() > sStart.getTime()) {
            lateMin = diffMinutes(d.firstIn, sStart)
          }
          // Early leave
          if (d.lastOut && d.lastOut.getTime() < sEnd.getTime()) {
            earlyMin = -diffMinutes(d.lastOut, sEnd)
          }
          // OT
          if (d.lastOut && d.lastOut.getTime() > sEnd.getTime()) {
            otMin = diffMinutes(d.lastOut, sEnd)
          }
        }
      } else if (d.firstIn && d.lastOut && leaves.some(lr => leaveCoversDate(lr, d.date))) {
        // ★ 2026-08-28：冇更表但有完整打卡 = 假期／休息日返工 → 全日當 OT
        //   ⚠️ 純顯示 —— 唔套 ot_min_minutes / ot_round_minutes（引擎會取整），金額以計糧為準
        const mins = diffMinutes(d.lastOut, d.firstIn) // ★ diffMinutes(later, earlier)
        if (mins > 0) otMin = mins
      }

      const flags: string[] = []
      if (!d.lastOut && d.firstIn) flags.push('MISSING_OUT')

      return {
        date: d.date,
        clinicName: d.clinicName,
        firstIn: d.firstIn ? d.firstIn.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Hong_Kong' }) : null,
        lastOut: d.lastOut ? d.lastOut.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Hong_Kong' }) : null,
        workedMinutes,
        lateMin,
        earlyMin,
        otMin,
        flags,
      }
    })

  // Pagination
  const total = days.length
  const paged = days.slice((page - 1) * pageSize, page * pageSize)

  return NextResponse.json(
    { days: paged, hasMore: page * pageSize < total },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  )
}
