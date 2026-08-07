export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { LEAVE_SYSTEM_KEYS } from '@/lib/leave-types'

// ============================================================
// POST /api/leave-balance/init — Batch initialize leave balances
// Roles: OWNER, MANAGER
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
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
    const { employeeId, leaveTypeId, days, year, mode, reason } = body

    // ★ 2026-08-07 add mode guards
    if (mode === 'add') {
      if (!Number.isInteger(days) || days <= 0) {
        return NextResponse.json(
          { error: '增加日數必須為正整數（要減請用初始化覆蓋）' }, { status: 400 })
      }
      if (!String(reason ?? '').trim()) {
        return NextResponse.json(
          { error: '請填寫增加原因（會寫入審計）' }, { status: 400 })
      }
    }

    if (!leaveTypeId || !days || !year) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 })
    }

    // ★ 年假採累積制（year=0），由 totalAccruedLeave 自動計算。
    // 喺呢度初始化會清零 used + 建立曆年 row，兩者都係錯。
    const lt = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } })
    if (lt?.systemKey === LEAVE_SYSTEM_KEYS.ANNUAL) {
      return NextResponse.json(
        { error: mode === 'add'
          ? '年假唔支持增加額度 —— 請用「重新計算假期」+「校正已用」'
          : '年假唔可以喺呢度初始化 —— 請用「重新計算假期」，如需校正已放天數請用「校正已用」' },
        { status: 400 },
      )
    }

    const targets = employeeId === 'all'
      ? (await prisma.employee.findMany()).map(e => e.id)
      : [employeeId]

    // 取得假期類型名稱
    const leaveType = await prisma.leaveType.findUnique({ where: { id: leaveTypeId }, select: { name: true } })
    const leaveTypeName = leaveType?.name || '未知假期'

    const results = []
    for (const empId of targets) {
      // ★ 病假不設額度（systemKey='SICK'），開餘額 row 只會令 UI 誤導
      const lt = await prisma.leaveType.findUnique({
        where: { id: leaveTypeId },
        select: { systemKey: true },
      })
      if (lt?.systemKey === 'SICK') continue

      // Read original values before upsert
      const before = await prisma.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: { employeeId: empId, leaveTypeId, year },
        },
      })

      const updateData = mode === 'add'
        ? { entitled: { increment: days }, remaining: { increment: days } }
        : { entitled: days, remaining: days, used: 0 }
      const result = await prisma.leaveBalance.upsert({
        where: {
          employeeId_leaveTypeId_year: { employeeId: empId, leaveTypeId, year },
        },
        update: updateData,
        create: { employeeId: empId, leaveTypeId, year, entitled: days, remaining: days, used: 0 },
      })

      // 取得員工名稱
      const emp = await prisma.employee.findUnique({ where: { id: empId }, include: { user: { select: { name: true } } } })
      const empName = emp?.user?.name || empId

      // ★ Write audit log: LEAVE_ADD or LEAVE_INIT
      if (mode === 'add') {
        await prisma.auditLog.create({
          data: {
            actorId: session.userId,
            action: 'LEAVE_ADD',
            entity: 'LeaveBalance',
            entityId: empId,
            targetEmployeeId: empId,
            beforeJson: JSON.stringify({ entitled: before?.entitled ?? 0, remaining: before?.remaining ?? 0 }),
            afterJson: JSON.stringify({
              entitled: result.entitled, remaining: result.remaining,
              delta: days, leaveType: leaveTypeName, reason: String(reason).trim() }),
            notes: `增加假期｜類型: ${leaveTypeName}｜對象: ${empName}｜年份: ${year}｜+${days}天｜原因: ${String(reason).trim()}`,
          },
        })
      } else {
        await prisma.auditLog.create({
          data: {
            actorId: session.userId,
            action: 'LEAVE_INIT',
            entity: 'LeaveBalance',
            entityId: empId,
            targetEmployeeId: empId,
            beforeJson: JSON.stringify({ entitled: before?.entitled ?? null, remaining: before?.remaining ?? null }),
            afterJson: JSON.stringify({ entitled: days, remaining: days }),
            notes: `假期類型: ${leaveTypeName}｜對象: ${empName}｜年份: ${year}｜額度: ${days}天`,
          },
        })
      }

      results.push(result)
    }

    return NextResponse.json({ count: results.length })
  } catch (error) {
    console.error('Init leave balance error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
