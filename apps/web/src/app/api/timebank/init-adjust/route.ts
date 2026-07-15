export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

const MINUTES_PER_DAY = 540

export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  // ★ OWNER only
  if (auth.session.role !== 'OWNER') {
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
    totalMinutes = Math.round(d * MINUTES_PER_DAY)
  } else {
    return NextResponse.json({ error: '需要員工、非零分鐘數與原因' }, { status: 400 })
  }

  if (!employeeId || !totalMinutes || !reason?.trim()) {
    return NextResponse.json({ error: '需要員工、非零分鐘數與原因' }, { status: 400 })
  }
  const date = new Date(`${effectiveMonth || new Date().toISOString().slice(0, 7)}-01T00:00:00+08:00`)

  await prisma.timeBankEntry.create({
    data: {
      employeeId,
      date,
      type: 'INIT_ADJUST',
      minutes: totalMinutes,
      note: `初始化調整 ${totalMinutes >= 0 ? '+' : ''}${totalMinutes} 分鐘：${reason.trim()}`,
      createdBy: auth.session.userId,
    },
  })

  await prisma.auditLog.create({
    data: {
      actorId: auth.session.userId,
      action: 'TIMEBANK_INIT_ADJUST',
      entity: 'TimeBank',
      entityId: employeeId,
      notes: JSON.stringify({ minutes: totalMinutes, effectiveMonth, reason: reason.trim() }),
    },
  } as any)

  await invalidateTimeBankFrom(employeeId, date, prisma)

  return NextResponse.json({ ok: true, minutes: totalMinutes })
}
