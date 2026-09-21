export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { TIMEBANK_MINUTES_PER_DAY } from '@/lib/timebank-constants'
import { todayHK, toHKDateStr } from '@/lib/hk-date'
import { flagIfSelfEdit } from '@/lib/self-edit-flag'
import { lockEmployee, toHttpResponse } from '@/lib/emp-lock'
import { assertMonthsUnlockedTx } from '@/lib/payroll-lock'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') { // ROLE-OK: 可憑空設定帳戶起始餘額，維持 OWNER-only
    return NextResponse.json({ error: '只有老闆可初始化時間帳戶' }, { status: 403 })
  }

  const { employeeId, minutes, days, effectiveMonth, reason } = await req.json()
  // Accept either minutes (direct) or days (backward compat)
  let totalMinutes: number
  if (minutes !== undefined && minutes !== null) {
    totalMinutes = Math.round(minutes)
  } else if (days !== undefined && days !== null) {
    const d = parseFloat(days)
    if (!isFinite(d) || d === 0) {
      return NextResponse.json({ error: '需要非零天數或非零分鐘數' }, { status: 400 })
    }
    totalMinutes = Math.round(d * TIMEBANK_MINUTES_PER_DAY) // ★ 2026-08-31：共享常數（原寫死 540）
  } else {
    return NextResponse.json({ error: '需要員工、非零分鐘數與原因' }, { status: 400 })
  }

  if (!employeeId || !totalMinutes || !reason?.trim()) {
    return NextResponse.json({ error: '需要員工、非零分鐘數與原因' }, { status: 400 })
  }
  const date = new Date(`${effectiveMonth || todayHK().slice(0, 7)}-01T00:00:00+08:00`)

  // ★ cwm-consistency Stage 4A.4（D1 硬鎖）：整段入 tx —— 先鎖人 + 新月/所有舊 INIT 月未凍結先准做
  //   （覆寫語義：刪除舊 INIT_ADJUST（初始化 = 設定基準，非累加））
  try {
    await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId)
      const oldInits = await tx.timeBankEntry.findMany({ where: { employeeId, type: 'INIT_ADJUST' } })
      const oldTotal = oldInits.reduce((s, e) => s + e.minutes, 0)
      const touchedMonths = [toHKDateStr(date), ...oldInits.map(o => toHKDateStr(o.date))]
      await assertMonthsUnlockedTx(tx, { actorId: auth.session.userId, employeeId, months: touchedMonths, what: '時間帳戶初始化' })
      await tx.timeBankEntry.deleteMany({ where: { employeeId, type: 'INIT_ADJUST' } })
      await tx.timeBankEntry.create({ data: {
        employeeId, date, type: 'INIT_ADJUST', minutes: totalMinutes,
        note: `初始化調整 ${totalMinutes >= 0 ? '+' : ''}${totalMinutes} 分鐘：${reason.trim()}`,
        createdBy: auth.session.userId } })
      await tx.auditLog.create({ data: {
        actorId: auth.session.userId, action: 'TIMEBANK_INIT_ADJUST', entity: 'TimeBank', entityId: employeeId,
        targetEmployeeId: employeeId,
        beforeJson: JSON.stringify({ initMinutes: oldTotal }), afterJson: JSON.stringify({ initMinutes: totalMinutes }),
        notes: JSON.stringify({ minutes: totalMinutes, effectiveMonth, reason: reason.trim() }) } } as any)
      // ★ CA-03：由最早嗰個月開始失效（舊 INIT 可能早過新嘅）
      const earliest = [date, ...oldInits.map(o => o.date)].reduce((a, b) => (a < b ? a : b))
      await invalidateTimeBankFrom(employeeId, earliest, tx)
    })
  } catch (e: any) {
    const r = toHttpResponse(e); if (r) return r
    throw e
  }

  // ★ cwm-antitamper P1-6：自己改自己標紅（記，唔擋）
  await flagIfSelfEdit({
    actorUserId: auth.session.userId,
    targetEmployeeId: employeeId,
    what: '時間帳戶初始化',
    detail: { minutes: totalMinutes, effectiveMonth, reason: reason.trim() },
    req,
  })

  return NextResponse.json({ ok: true, minutes: totalMinutes })
}
