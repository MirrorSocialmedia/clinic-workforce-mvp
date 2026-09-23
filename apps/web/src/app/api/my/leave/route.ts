export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr, getMonthRange } from '@/lib/hk-date'
import { balanceYearFor } from '@/lib/leave-types'
import { jsonNoStore } from '@/lib/api-response'
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
    // ★ cwm-leaveasoffix-20260923 S2-2：舊年行唔可以篩走 —— 1 月頭員工仲要睇到上年剩低嘅
    //   休息日／OT 補假（舊版由 /api/leave-balance 攞，係唔篩年份嘅）。year=0（累積制）≤ currentYear。
    where: { employeeId: employee.id, year: { lte: currentYear } },
    include: {
      leaveType: { select: { id: true, name: true, isPaid: true, annualQuota: true, color: true, systemKey: true } },
    },
  })

  // ★ cwm-leaveasof-20260922：休息日用現成 restDayBalanceAsOf（薪資明細、排班上月剩同一個口徑）；
  //   其餘（年假／生日假／OT補假）用 accumulativeBalanceAsOf。
  //   ⚠️ 欄名（entitled/used/remaining）【唔改】—— my/dashboard 同 my/leave 兩頁直接用，改名就要改兩頁。
  const restRow = balances.find(b => b.leaveType.systemKey === 'REST_DAY' && b.year === currentYear)
  const otherRows = balances.filter(b => b.leaveType.systemKey !== 'REST_DAY')

  // ★ cwm-leaveasoffix-20260923 S2-3：四個唔相干嘅 query 並行（原本串行 4 個 round trip；
  //   本 endpoint 係 my/dashboard + my/leave 兩頁嘅 60s 輪詢來源）
  const [restAsOfMap, otherAsOf, upcoming, leaveTypes] = await Promise.all([
    restRow
      ? restDayBalanceAsOf(prisma, [employee.id], asOf)
      : Promise.resolve(new Map<string, { entitled: number; used: number; remaining: number }>()),
    accumulativeBalanceAsOf(prisma, employee.id, otherRows as any, asOf),
    upcomingLeaveByMonth(prisma, employee.id, asOf),
    prisma.leaveType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
  ])
  const restAsOf = restAsOfMap.get(employee.id)

  const asOfBalances = balances.map(b => {
    // ★ cwm-leaveasoffix-20260923 S2-1：as-of 只有喺「寫入路徑會扣呢一行」先成立。
    //   legacy 曆年年假行（year=2026 而 balanceYearFor(ANNUAL)=0）同舊年行都唔成立 ——
    //   舊版照樣出「（截至 X 月）」label 但數字係即時值，員工會連預排明細一齊重複計。
    const supported = b.year === balanceYearFor(b.leaveType.systemKey, monthEnd)
    if (!supported) return { ...b, asOfSupported: false }
    const v = b.leaveType.systemKey === 'REST_DAY'
      ? restAsOf
      : otherAsOf.get(`${b.leaveTypeId}:${b.year}`)
    // ★ 攞唔到 as-of（例如休息日冇當年行）→ 照用原始值，唔好憑空變 0
    return v
      ? { ...b, entitled: v.entitled, used: v.used, remaining: v.remaining, asOfSupported: true }
      : { ...b, asOfSupported: false }
  })

  // ★ cwm-leaveasoffix-20260923 S2-4：本 route 而家係員工端唯一餘額來源 —— 一定要 no-store
  //   （/api/leave-balance 一直係 jsonNoStore；guard check-get-no-store.sh 只查有寫入 method 嘅 route，捉唔到呢個）
  return jsonNoStore({ leaveRequests: requests, leaveBalances: asOfBalances, leaveTypes, asOf, upcoming })
}
