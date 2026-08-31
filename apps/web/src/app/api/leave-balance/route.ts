export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { LEAVE_SYSTEM_KEYS, isAccumulativeLeave } from '@/lib/leave-types'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'

// ============================================================
// GET /api/leave-balance — Get leave balance
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// Employee sees own; managers see all (optionally filtered by employeeId)
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  try {
    const { searchParams } = new URL(req.url)
    const employeeId = searchParams.get('employeeId')
    const year = searchParams.get('year')

    // ★ 2026-08-31 cwm-leaveasof：asOf = 'YYYY-MM-DD'（HK）。
    //   傳咗就重算「截至嗰日」嘅 entitled / used；唔傳照回 LeaveBalance 即時值
    //   （其餘 4 個 caller —— 排班／假期管理／帳號管理 —— 一行都唔使改）。
    const asOf = searchParams.get('asOf')
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      return NextResponse.json({ error: 'asOf 格式必須係 YYYY-MM-DD' }, { status: 400 })
    }
    // ★ HK 日界：asOf 當日 23:59:59.999 HK —— 一定要用現有 hkDateEnd，唔好自己砌 Date：
    //   RESTDAY_GRANT 存 HK 月初（UTC 上月最後一日 16:00），用 UTC 午夜做界會令下月嗰筆照樣入。
    //   例：RESTDAY_GRANT 2026-08-31T16:00Z = 2026-09-01 00:00 HK，asOf=2026-08-31 必須排除佢。
    const asOfEnd = asOf ? hkDateEnd(asOf) : null
    // ★ 年度界（曆年類型）：只計 asOf 同一曆年；累積類型（year=0）由入職累計，唔設下界。
    const yearStart = asOf ? hkDateStart(`${asOf.slice(0, 4)}-01-01`) : null
    const asOfYear = asOf ? parseInt(asOf.slice(0, 4), 10) : 0

    let targetEmployeeId: string | undefined

    // Employees only see their own balance
    if (scope === 'self') {
      const emp = await prisma.employee.findUnique({
        where: { userId: session.userId },
      })
      if (!emp) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })
      if (employeeId && employeeId !== emp.id) {
        return NextResponse.json(
          { error: 'Forbidden (cannot read other employees\' leave balance)' },
          { status: 403 },
        )
      }
      targetEmployeeId = emp.id
    } else if (employeeId) {
      targetEmployeeId = employeeId
    }

    const where: any = targetEmployeeId ? { employeeId: targetEmployeeId } : {}
    if (year) where.year = parseInt(year)

    const balances = await prisma.leaveBalance.findMany({
      where,
      include: {
        leaveType: { select: { id: true, name: true, isPaid: true, annualQuota: true, color: true, systemKey: true } },
        employee: {
          // Prisma does not allow select + include on the same level.
          // (2026-08-03: adding annualLeaveBreakdown needed joinDate, changed to select+include, causing 500)
          select: {
            joinDate: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ year: 'desc' }, { leaveType: { name: 'asc' } }],
    })

    // 系統實際已批天數
    const empIds = [...new Set(balances.map(b => b.employeeId))]
    const typeIds = [...new Set(balances.map(b => b.leaveTypeId))]

    const approved = empIds.length > 0 ? await prisma.leaveRequest.groupBy({
      by: ['employeeId', 'leaveTypeId'],
      where: {
        employeeId: { in: empIds },
        leaveTypeId: { in: typeIds },
        status: 'APPROVED',
      },
      _sum: { days: true },
    }) : []

    const sysMap = new Map(
      approved.map(a => [`${a.employeeId}:${a.leaveTypeId}`, a._sum.days ?? 0]),
    )

    // ★ 2026-08-31 cwm-leaveasof：asOf 重算（純讀取層，LeaveBalance 一行都唔改）。
    //   used：LeaveRequest APPROVED 按 startDate 歸月，一次撈晒再 JS 分組
    //   （groupBy 做唔到「唔同類型唔同年界」）。
    //   entitled：只有 REST_DAY 有「截至」來源（RESTDAY_GRANT 逐筆加總）；
    //   其餘類型（年假／生日假／OT 補假）冇逐月記錄 → 回原值 + asOfSupported=false。
    let asOfUsedByType: Map<string, number> | null = null
    let restGrantByEmp: Map<string, number> | null = null
    if (asOfEnd) {
      const reqWhere: any = { status: 'APPROVED', startDate: { lte: asOfEnd! } }
      if (targetEmployeeId) reqWhere.employeeId = targetEmployeeId
      const requests = await prisma.leaveRequest.findMany({
        where: reqWhere,
        select: { leaveTypeId: true, days: true, startDate: true },
      })
      const typeIdToSystemKey = new Map(
        balances.map(b => [b.leaveTypeId, b.leaveType.systemKey as string | null]),
      )
      asOfUsedByType = new Map()
      for (const r of requests) {
        const sysKey = typeIdToSystemKey.get(r.leaveTypeId)
        if (sysKey == null) continue
        // 曆年類型（休息日／OT 補假）：只計同一曆年；累積類型（年假／生日假 year=0）：唔設下界
        if (!isAccumulativeLeave(sysKey) && r.startDate.getTime() < yearStart!.getTime()) continue
        asOfUsedByType.set(r.leaveTypeId, (asOfUsedByType.get(r.leaveTypeId) ?? 0) + (r.days ?? 0))
      }
      const grantWhere: any = {
        type: 'RESTDAY_GRANT',
        date: { gte: yearStart!, lte: asOfEnd! },
      }
      if (targetEmployeeId) grantWhere.employeeId = targetEmployeeId
      const restGrants = await prisma.timeBankEntry.findMany({
        where: grantWhere,
        select: { employeeId: true, minutes: true },
      })
      // ★ minutes / 1440 = 日數（同 payroll-engine 發放時 Math.round(minutes/(24*60)) 一致）
      restGrantByEmp = new Map()
      for (const g of restGrants) {
        restGrantByEmp.set(g.employeeId, (restGrantByEmp.get(g.employeeId) ?? 0) + Math.round(g.minutes / 1440))
      }
    }

    return jsonNoStore({
      ...(asOf ? { asOf } : {}),
      leaveBalances: balances.map(b => {
        const lt = b.leaveType
        const base = {
          ...b,
          systemUsed: sysMap.get(`${b.employeeId}:${b.leaveTypeId}`) ?? 0,
        }
        // ★ 只有搵到「截至」來源嘅類型先重算；其餘照回原值 + 標記，前端唔顯示「截至」。
        //   另外要求 row 嘅曆年 = asOf 曆年（REST_DAY 行係按年開嘅，跨年行唔適用）。
        const supported =
          asOf != null &&
          lt.systemKey === LEAVE_SYSTEM_KEYS.REST_DAY &&
          b.year === asOfYear
        if (!supported) return { ...base, asOfSupported: false }
        const entitled = restGrantByEmp!.get(b.employeeId) ?? 0
        const used = asOfUsedByType!.get(b.leaveTypeId) ?? 0
        // ★ 唔 clamp —— REST_DAY 可預支（NEGATIVE_ALLOWED_KEYS），九月 −1 係正確值
        return { ...base, entitled, used, remaining: entitled - used, asOfSupported: true }
      }),
    })
  } catch (error) {
    console.error('[leave-balance GET]', error)
    return NextResponse.json({ error: '載入假期餘額失敗' }, { status: 500 })
  }
}

// ============================================================
// PATCH /api/leave-balance — Update leave balance (entitled/remaining)
// Roles: OWNER, MANAGER
// ============================================================
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req, 'PATCH', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  if (!(perms ?? []).includes('leave_approve')) {
    return NextResponse.json(
      { error: 'Forbidden (missing permission: leave_approve)' },
      { status: 403 },
    )
  }

  try {
    const body = await req.json()
    const { balanceId, entitled, used } = body

    if (!balanceId) {
      return NextResponse.json({ error: 'balanceId is required' }, { status: 400 })
    }

    // ★ 先檢查有冇真嘢改，再推導 remaining ——
    //   remaining 無條件寫入會令下面個 Object.keys() 檢查永遠通過，
    //   結果係「乜都唔改」都會寫 DB + 寫審計。
    if (entitled === undefined && used === undefined) {
      return NextResponse.json(
        { error: '冇任何可更新欄位（entitled / used）' },
        { status: 400 },
      )
    }

    const updateData: any = {}
    if (entitled !== undefined) updateData.entitled = entitled

    // ★ used 係「真實已放天數」—— 支援人手校正（例如舊系統遷移過嚟嘅歷史假期）。
    //   refresh 唔會覆蓋 used，所以人手改咗會保留。
    if (used !== undefined) {
      if (typeof used !== 'number' || used < 0) {
        return NextResponse.json({ error: '已用天數必須係 0 或以上嘅數字' }, { status: 400 })
      }
      updateData.used = used
    }

    const cur = await prisma.leaveBalance.findUnique({ where: { id: balanceId } })
    if (!cur) return NextResponse.json({ error: '找不到餘額記錄' }, { status: 404 })

    const nextEntitled = updateData.entitled ?? cur.entitled
    const nextUsed = updateData.used ?? cur.used
    updateData.remaining = Math.max(0, nextEntitled - nextUsed)

    // ★ 值完全冇變就唔好寫 DB／寫審計（例如前端重複送同一個值）
    if (
      nextEntitled === cur.entitled &&
      nextUsed === cur.used &&
      updateData.remaining === cur.remaining
    ) {
      return NextResponse.json({ success: true, leaveBalance: cur, unchanged: true })
    }

    // ★ 2026-08-04: 包裝在 $transaction —— 審計失敗 = 資料唔改
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.leaveBalance.update({
        where: { id: balanceId },
        data: updateData,
        include: {
          leaveType: { select: { id: true, name: true } },
          employee: { include: { user: { select: { id: true, name: true } } } },
        },
      })

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'LEAVE_BALANCE_ADJUST',
          entity: 'LeaveBalance',
          entityId: balanceId,
          targetEmployeeId: cur.employeeId,
          beforeJson: JSON.stringify({ entitled: cur.entitled, used: cur.used, remaining: cur.remaining }),
          afterJson: JSON.stringify({ entitled: nextEntitled, used: nextUsed, remaining: updateData.remaining }),
          notes: `校正${u.leaveType?.name ?? ''}已用：${cur.used} → ${nextUsed}`,
          ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
          userAgent: req.headers.get('user-agent') ?? null,
        },
      })

      return u
    })

    return NextResponse.json({ success: true, leaveBalance: updated })
  } catch (error) {
    console.error('Update leave balance error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============================================================
// DELETE /api/leave-balance — Clear leave balances
// Roles: OWNER
// ============================================================
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  if (session.role !== 'OWNER') { // ROLE-OK: 批量刪除假期餘額只准 OWNER
    return NextResponse.json({ error: 'Forbidden (only OWNER can clear leave balances)' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const year = parseInt(searchParams.get('year') || '0')

  if (!year) return NextResponse.json({ error: '需要年份参数' }, { status: 400 })

  // ★ 2026-08-04: 逐行審計——先查舊值，再入 transaction 刪除 + 審計
  const whereClause: any = { year }
  if (employeeId && employeeId !== 'all') whereClause.employeeId = employeeId

  const rowsToDelete = await prisma.leaveBalance.findMany({
    where: whereClause,
    include: {
      leaveType: { select: { id: true, name: true } },
      employee: { select: { id: true, user: { select: { id: true, name: true } } } },
    },
  })

  let deletedCount = 0
  for (const row of rowsToDelete) {
    await prisma.$transaction(async (tx) => {
      await tx.leaveBalance.delete({ where: { id: row.id } })

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'LEAVE_BALANCE_DELETE',
          entity: 'LeaveBalance',
          entityId: row.id,
          targetEmployeeId: row.employeeId,
          beforeJson: JSON.stringify({
            entitled: row.entitled,
            used: row.used,
            remaining: row.remaining,
            leaveTypeName: row.leaveType?.name ?? '',
            employeeName: row.employee?.user?.name ?? '',
          }),
          afterJson: null,
          notes: `刪除${row.leaveType?.name ?? ''}餘額 (${row.employee?.user?.name ?? ''}, 年份 ${year})`,
          ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
          userAgent: req.headers.get('user-agent') ?? null,
        },
      })

      deletedCount++
    })
  }

  return NextResponse.json({ count: deletedCount })
}
