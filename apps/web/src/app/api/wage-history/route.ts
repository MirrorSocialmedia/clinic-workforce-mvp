import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { periodMonthKey } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/wage-history?employeeId=xxx
// Returns merged PayrollItem + WageHistory for the employee
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  if (!employeeId) {
    return NextResponse.json({ error: 'employeeId required' }, { status: 400 })
  }

  const [payrollItems, wageHistories] = await Promise.all([
    prisma.payrollItem.findMany({
      where: { employeeId },
      include: { run: { select: { periodMonth: true } } },
      orderBy: { run: { periodMonth: 'asc' } },
    }),
    prisma.wageHistory.findMany({
      where: { employeeId },
      orderBy: { periodMonth: 'asc' },
    }),
  ])

  // Merge: PayrollItem takes priority
  const byMonth = new Map<string, any>()

  for (const wh of wageHistories) {
    byMonth.set(wh.periodMonth, {
      id: wh.id,
      rowKey: `wh:${wh.id}`,
      periodMonth: wh.periodMonth,
      wage: wh.totalWage,
      excludedDays: wh.excludedDays,
      excludedWage: wh.excludedWage,
      calendarDays: wh.calendarDays,
      source: 'WageHistory',
      editable: true,
      note: wh.note,
    })
  }

  for (const pi of payrollItems) {
    // ★ PayrollRun.periodMonth is HK midnight (upper midnight of month start).
    //   toISOString() converts to UTC → off by 1 month. Must use periodMonthKey.
    const pm = (pi.run as any).periodMonth
    const pmStr = periodMonthKey(pm)
    byMonth.set(pmStr, {
      id: pi.id,
      rowKey: `pi:${pi.id}`,
      periodMonth: pmStr,
      wage: (pi as any).eoWage ?? 0,
      excludedDays: (pi as any).excludedDays ?? 0,
      excludedWage: (pi as any).excludedWage ?? 0,
      calendarDays: (() => {
        const [y, m] = pmStr.split('-').map(Number)
        return new Date(Date.UTC(y, m, 0)).getUTCDate()
      })(),
      source: 'PayrollItem',
      editable: false,
    })
  }

  const rows = [...byMonth.values()].sort((a, b) =>
    a.periodMonth.localeCompare(b.periodMonth),
  )

  return jsonNoStore({ employeeId, rows })
}

// ============================================================
// POST /api/wage-history
// Create a WageHistory record
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json()
  const { employeeId, periodMonth, totalWage, excludedDays, excludedWage, note } = body

  if (!employeeId || !periodMonth || totalWage == null) {
    return NextResponse.json(
      { error: 'employeeId, periodMonth, totalWage required' },
      { status: 400 },
    )
  }

  // Calculate calendarDays from periodMonth
  const [y, m] = periodMonth.split('-').map(Number)
  const calendarDays = new Date(Date.UTC(y, m, 0)).getUTCDate()

  const entry = await prisma.wageHistory.create({
    data: {
      employeeId,
      periodMonth,
      totalWage: Number(totalWage),
      excludedDays: Number(excludedDays ?? 0),
      excludedWage: Number(excludedWage ?? 0),
      calendarDays,
      note: note || null,
      createdBy: auth.session.userId,
    },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: auth.session.userId,
      action: 'WAGE_HISTORY_CREATE',
      entity: 'WageHistory',
      entityId: entry.id,
      targetEmployeeId: employeeId,
      afterJson: JSON.stringify({
        totalWage: entry.totalWage,
        excludedDays: entry.excludedDays,
        excludedWage: entry.excludedWage,
        periodMonth: entry.periodMonth,
      }),
    } as any,
  })

  return NextResponse.json(entry)
}
