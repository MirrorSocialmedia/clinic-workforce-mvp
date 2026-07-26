export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError, assertClinicAccess } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

// POST /api/punches/[id]/void — Void a punch record (OWNER/MANAGER)
export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { reason } = await req.json()
  const id = ctx.params.id

  if (!reason?.trim()) {
    return NextResponse.json({ error: '必須填寫作廢原因' }, { status: 400 })
  }

  // Check punch record exists
  const punch = await prisma.punchRecord.findUnique({ where: { id } })
  if (!punch) {
    return NextResponse.json({ error: '打卡記錄不存在' }, { status: 404 })
  }

  // ★ IDOR: MANAGER 只可以作廢自己店嘅打卡
  const denied = assertClinicAccess(scope, session, punch.clinicId)
  if (denied) return denied

  // Check not already voided
  const existingVoid = await prisma.punchVoid.findUnique({
    where: { punchRecordId: id },
  })
  if (existingVoid) {
    return NextResponse.json({ error: '此打卡記錄已被作廢' }, { status: 400 })
  }

  await prisma.punchVoid.create({
    data: { punchRecordId: id, voidedBy: session.userId, reason },
  })

  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'VOID_PUNCH',
      entity: 'PunchRecord',
      entityId: id,
      targetEmployeeId: punch.employeeId,
      notes: `作廢打卡：${reason}`,
    },
  })

  // Invalidate TimeBank so carry chain recalculates from void date
  await invalidateTimeBankFrom(punch.employeeId, punch.punchTime, prisma)

  return NextResponse.json({ ok: true })
}
