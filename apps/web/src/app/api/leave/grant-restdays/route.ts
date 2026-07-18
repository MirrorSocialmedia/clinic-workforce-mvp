export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { grantMonthlyRestDays, countMonthlyLeaveDays } from '@/lib/payroll-engine'
import { hkParts } from '@/lib/hk-date'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error as NextResponse
  if (auth.session.role !== 'OWNER') return NextResponse.json({ error: '僅老闆可發放' }, { status: 403 })

  const { which, employeeScope } = await req.json()
  // which: 'this' | 'next'
  // employeeScope: 'all' | employeeId string

  const base = new Date()
  const target = which === 'next' ? new Date(base.getFullYear(), base.getMonth() + 1, 1) : base
  const { y, m } = hkParts(target) // m is 0-indexed

  let emps: Array<{ id: string }>
  if (employeeScope === 'all') {
    emps = await prisma.employee.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
  } else if (employeeScope) {
    const emp = await prisma.employee.findUnique({ where: { id: employeeScope }, select: { id: true } })
    emps = emp ? [emp] : []
  } else {
    emps = []
  }

  let n = 0
  for (const e of emps) {
    const rule = await prisma.payRule.findFirst({
      where: { employeeId: e.id, isActive: true },
      orderBy: { effectiveFrom: 'desc' },
    })
    const cfg = rule?.configJson
      ? (typeof rule.configJson === 'string' ? JSON.parse(rule.configJson) : rule.configJson)
      : {}
    const restDays = cfg.working_days?.rest_days ?? [6, 0]
    const quota = countMonthlyLeaveDays(y, m, restDays)
    await grantMonthlyRestDays(e.id, y, m, quota.total, prisma)
    n++
  }

  return NextResponse.json({
    ok: true,
    granted: n,
    month: `${y}-${String(m + 1).padStart(2, '0')}`,
  })
}
