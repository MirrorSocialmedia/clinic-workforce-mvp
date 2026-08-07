export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr } from '@/lib/hk-date'

/**
 * GET /api/schedule-coverage
 *
 * Independent count of shifts + approved leaves per employee+date.
 * Zero take, zero truncation — returns every single shift and leave day.
 * Frontend can cross-reference with displayed cells to detect display bugs.
 *
 * Query params: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD) — required
 * Response: { coverage: { "empId|YYYY-MM-DD": "SS...L..." } }
 *   Each 'S' = one shift, each 'L' = one leave day.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const searchParams = req.nextUrl.searchParams
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')
  if (!startDate || !endDate) {
    return NextResponse.json(
      { error: 'startDate and endDate required' },
      { status: 400 },
    )
  }

  const rangeStart = new Date(`${startDate}T00:00:00+08:00`)
  const rangeEnd = new Date(`${endDate}T23:59:59+08:00`)

  // ① Shifts: fetch all non-cancelled shifts in range
  const shifts = await prisma.shift.findMany({
    where: {
      date: { gte: rangeStart, lte: rangeEnd },
      status: { not: 'CANCELLED' },
    },
    select: { employeeId: true, date: true },
  })

  // ② Leave requests: APPROVED only, expand date range in JS
  const leaves = await prisma.leaveRequest.findMany({
    where: {
      status: 'APPROVED',
      startDate: { lte: rangeEnd },
      endDate: { gte: rangeStart },
    },
    select: { employeeId: true, startDate: true, endDate: true },
  })

  // Build coverage map: key = "empId|YYYY-MM-DD", value = string of S/L chars
  const coverage = new Map<string, string>()

  for (const s of shifts) {
    const key = `${s.employeeId}|${toHKDateStr(new Date(s.date))}`
    coverage.set(key, (coverage.get(key) || '') + 'S')
  }

  // Expand leave date ranges
  for (const lr of leaves) {
    let cur = lr.startDate
    const last = lr.endDate || lr.startDate
    while (cur.getTime() <= last.getTime()) {
      // Clamp to query range
      if (cur.getTime() >= rangeStart.getTime() && cur.getTime() <= rangeEnd.getTime()) {
        const key = `${lr.employeeId}|${toHKDateStr(cur)}`
        const existing = coverage.get(key) || ''
        coverage.set(key, existing + 'L')
      }
      cur = new Date(cur.getTime() + 86400000) // +1 day
    }
  }

  return NextResponse.json({ coverage: Object.fromEntries(coverage) })
}
