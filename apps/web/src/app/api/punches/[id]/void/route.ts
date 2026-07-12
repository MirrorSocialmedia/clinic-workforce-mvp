export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

// POST /api/punches/[id]/void — Void a punch record (OWNER only)
export async function POST(req: Request, ctx: { params: { id: string } }) {
  const session = await requireRole(['OWNER'])
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
      notes: `作廢打卡：${reason}`,
    },
  })

  return NextResponse.json({ ok: true })
}
