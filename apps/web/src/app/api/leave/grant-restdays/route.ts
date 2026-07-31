export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { grantMonthlyRestDays, countMonthlyLeaveDays } from '@/lib/payroll-engine'
import { hkParts, toHKDateStr } from '@/lib/hk-date'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error as NextResponse
  const { session, perms } = auth
  // ★ 排休息日係排班工作嘅一部分 —— 冇發放權就會撞死路
  //   （leave-requests:233 個提示叫用家去發放，但佢哋冇權）
  if (!(perms ?? []).includes('scheduling')) {
    return NextResponse.json(
      { error: 'Forbidden (missing permission: scheduling)' },
      { status: 403 },
    )
  }

  const { which, employeeScope } = await req.json()
  // which: 'this' | 'next'
  // employeeScope: 'all' | employeeId string

  const base = new Date()
  // ★ 唔好用 new Date(y, m, 1) —— 伺服器 UTC，得出 UTC 午夜（差 8 小時）
  const baseYm = toHKDateStr(base).slice(0, 7)
  const [by, bm] = baseYm.split('-').map(Number)
  const nextYm = bm === 12 ? `${by + 1}-01` : `${by}-${String(bm + 1).padStart(2, '0')}`
  const target = which === 'next'
    ? new Date(`${nextYm}-01T00:00:00+08:00`)
    : base
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
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    })
    // ★ 兼職（HOURLY）不發休息日
    if (rule?.payType === 'HOURLY') continue
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
