export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/punches/[id] — Single punch record + full correction chain
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const record = await prisma.punchRecord.findUnique({
    where: { id: params.id },
    include: {
      employee: { include: { user: { select: { id: true, name: true, phone: true } } } },
      clinic: { select: { id: true, name: true } },
      corrections: { orderBy: { createdAt: 'asc' } },
    },
  })

  if (!record) return NextResponse.json({ error: 'Record not found' }, { status: 404 })

  const chain: any[] = [{
    type: 'original', id: record.id,
    punchTime: record.punchTime.toISOString(), punchType: record.punchType,
    source: record.source, tokenValid: record.tokenValid,
    deviceInfo: record.deviceInfo, notes: record.notes,
    createdAt: record.createdAt.toISOString(),
  }]

  for (const correction of record.corrections) {
    chain.push({
      type: 'correction', id: correction.id,
      correctedTime: correction.correctedTime.toISOString(),
      punchType: correction.punchType, reason: correction.reason,
      requestedBy: correction.requestedBy, approvedBy: correction.approvedBy,
      status: correction.status,
      createdAt: correction.createdAt.toISOString(),
      updatedAt: correction.updatedAt.toISOString(),
    })
  }

  return NextResponse.json({
    record: {
      id: record.id, employeeId: record.employeeId, clinicId: record.clinicId,
      punchTime: record.punchTime.toISOString(), punchType: record.punchType,
      source: record.source, tokenValid: record.tokenValid,
      deviceInfo: record.deviceInfo, notes: record.notes,
      createdAt: record.createdAt.toISOString(),
      employee: record.employee, clinic: record.clinic,
    },
    chain,
  })
}

// PUT /api/punches/[id] — 真正更新那筆打卡（非建新筆）
// Roles: OWNER, MANAGER
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json().catch(() => ({}))
  const { punchTime, punchType, notes, reason } = body

  const record = await prisma.punchRecord.findUnique({ where: { id: params.id } })
  if (!record) return NextResponse.json({ error: '記錄不存在' }, { status: 404 })

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.punchRecord.update({
      where: { id: params.id },
      data: {
        ...(punchTime ? { punchTime: new Date(punchTime) } : {}),
        ...(punchType ? { punchType } : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
    })
    // 修改審計（防篡改）
    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'PUNCH_EDIT',
        entity: 'PunchRecord',
        entityId: params.id,
        afterJson: JSON.stringify({
          oldValue: { punchTime: record.punchTime.toISOString(), punchType: record.punchType },
          newValue: { punchTime, punchType },
          reason: reason || '管理端編輯',
        }),
        ipAddress: req.headers.get('x-forwarded-for') || null,
        userAgent: req.headers.get('user-agent') || null,
      },
    })
    return u
  })

  return NextResponse.json({ ok: true, record: { id: updated.id } })
}
