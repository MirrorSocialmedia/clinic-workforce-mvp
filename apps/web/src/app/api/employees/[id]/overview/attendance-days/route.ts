export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope, canSeeConfidential } from '@/lib/scope-helpers'
import { hkDateStart, hkDateEnd, toHKDateStr } from '@/lib/hk-date'

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

  const days = Array.from(dayMap.values())
    .map(d => {
      let workedMinutes = null
      if (d.firstIn && d.lastOut) {
        workedMinutes = Math.round((d.lastOut - d.firstIn) / 60000)
      }
      const flags: string[] = []
      if (!d.lastOut && d.firstIn) flags.push('MISSING_OUT')
      // Check late against shift
      // (shift check can be added later)
      return {
        date: d.date,
        clinicName: d.clinicName,
        firstIn: d.firstIn ? d.firstIn.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Hong_Kong' }) : null,
        lastOut: d.lastOut ? d.lastOut.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Hong_Kong' }) : null,
        workedMinutes,
        lateMin: 0,
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
