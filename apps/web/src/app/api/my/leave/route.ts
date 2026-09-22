export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr, getMonthRange } from '@/lib/hk-date'
import { restDayBalanceAsOf, accumulativeBalanceAsOf, upcomingLeaveByMonth } from '@/lib/leave-balance-as-of'

// ============================================================
// GET /api/my/leave — My leave requests + balance
// All roles — returns the current employee's data
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
  })

  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const requests = await prisma.leaveRequest.findMany({
    where: { employeeId: employee.id },
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, color: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  // ★ 2026-08-04: 累積制假期（年假/生日假）用 year=0，要一併撈返
  // ★ cwm-leaveasof-20260922 ⑤：用 HK 年份 —— getUTCFullYear 喺 HK 1/1 00:00–07:59 會攞到舊年
  const todayHK = toHKDateStr(new Date())
  const currentYear = Number(todayHK.slice(0, 4))
  // ★ 拍板①：截至【當月月底】
  const { end: monthEnd } = getMonthRange(new Date(`${todayHK.slice(0, 7)}-01T00:00:00+08:00`))
  const asOf = toHKDateStr(monthEnd)       // 'YYYY-MM-DD'

  const balances = await prisma.leaveBalance.findMany({
    where: { employeeId: employee.id, year: { in: [currentYear, 0] } },
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, annualQuota: true, color: true, systemKey: true } },
    },
  })

  // ★ cwm-leaveasof-20260922：休息日用現成 restDayBalanceAsOf（薪資明細、排班上月剩同一個口徑）；
  //   其餘（年假／生日假／OT補假）用 accumulativeBalanceAsOf。
  //   ⚠️ 欄名（entitled/used/remaining）【唔改】—— my/dashboard 同 my/leave 兩頁直接用，改名就要改兩頁。
  const restRow = balances.find(b => b.leaveType.systemKey === 'REST_DAY' && b.year === currentYear)
  const restAsOf = restRow ? (await restDayBalanceAsOf(prisma, [employee.id], asOf)).get(employee.id) : undefined
  const otherRows = balances.filter(b => b.leaveType.systemKey !== 'REST_DAY')
  const otherAsOf = await accumulativeBalanceAsOf(prisma, employee.id, otherRows as any, asOf)

  const asOfBalances = balances.map(b => {
    const v = b.leaveType.systemKey === 'REST_DAY'
      ? (b.year === currentYear ? restAsOf : undefined)
      : otherAsOf.get(`${b.leaveTypeId}:${b.year}`)
    // ★ 攞唔到 as-of（例如休息日冇當年行）→ 照用原始值，唔好憑空變 0
    return v ? { ...b, entitled: v.entitled, used: v.used, remaining: v.remaining } : b
  })

  const upcoming = await upcomingLeaveByMonth(prisma, employee.id, asOf)

  const leaveTypes = await prisma.leaveType.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  })

  return NextResponse.json({ leaveRequests: requests, leaveBalances: asOfBalances, leaveTypes, asOf, upcoming })
}
