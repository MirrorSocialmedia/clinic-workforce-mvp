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

  const { employeeId, days, effectiveMonth, reason } = await req.json()
  const d = parseFloat(days)
  if (!employeeId || !isFinite(d) || d === 0 || !reason?.trim()) {
    return NextResponse.json({ error: '需要員工、非零天數與原因' }, { status: 400 })
  }

  const minutes = Math.round(d * MINUTES_PER_DAY)
  const date = new Date(`${effectiveMonth || new Date().toISOString().slice(0, 7)}-01T00:00:00+08:00`)

  await prisma.timeBankEntry.create({
    data: {
      employeeId,
      date,
      type: 'INIT_ADJUST',
      minutes,
      note: `初始化調整 ${d > 0 ? '+' : ''}${d} 日：${reason.trim()}`,
      createdBy: auth.session.userId,
    },
  })

  await prisma.auditLog.create({
    data: {
      actorId: auth.session.userId,
      action: 'TIMEBANK_INIT_ADJUST',
      entity: 'TimeBank',
      entityId: employeeId,
      notes: JSON.stringify({ days: d, minutes, effectiveMonth, reason: reason.trim() }),
    },
  } as any)

  await invalidateTimeBankFrom(employeeId, date, prisma)

  return NextResponse.json({ ok: true, minutes })
}
