export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/punches/[id] — Single punch record + full correction chain
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
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
      // Face verification fields
      faceStatus: record.faceStatus,
      faceScore: record.faceScore,
      faceReason: record.faceReason,
      faceFramePath: record.faceFramePath,
      faceReviewedAt: record.faceReviewedAt?.toISOString() ?? null,
      faceReviewedBy: record.faceReviewedBy,
      // GPS location fields
      punchLat: record.punchLat,
      punchLng: record.punchLng,
      distanceM: record.distanceM,
      locationFlag: record.locationFlag,
      geoAccuracy: record.geoAccuracy,
    },
    chain,
  })
}

// PUT /api/punches/[id] — 編輯打卡（void 舊筆 + 建新筆）
// Roles: OWNER, MANAGER
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json().catch(() => ({}))
  const { punchTime, punchType, notes, reason } = body

  const oldRecord = await prisma.punchRecord.findUnique({ where: { id: params.id } })
  if (!oldRecord) return NextResponse.json({ error: '記錄不存在' }, { status: 404 })

  // 檢查是否已被 void
  const existingVoid = await prisma.punchVoid.findUnique({ where: { punchRecordId: params.id } })
  if (existingVoid) return NextResponse.json({ error: '此記錄已被作廢' }, { status: 400 })

  // 在 transaction 內執行三步
  const newRecord = await prisma.$transaction(async (tx) => {
    // ① 作廢舊筆
    await tx.punchVoid.create({
      data: {
        punchRecordId: params.id,
        voidedBy: session.userId,
        reason: reason || '管理端更正',
      },
    })
    // ② 建新筆
    const nr = await tx.punchRecord.create({
      data: {
        employeeId: oldRecord.employeeId,
        clinicId: oldRecord.clinicId,
        punchTime: punchTime ? new Date(punchTime) : oldRecord.punchTime,
        punchType: punchType || oldRecord.punchType,
        source: oldRecord.source,
        tokenValid: oldRecord.tokenValid,
        deviceInfo: oldRecord.deviceInfo,
        notes: notes !== undefined ? notes : oldRecord.notes,
      },
    })
    // ③ 審計
    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'PUNCH_EDIT',
        entity: 'PunchRecord',
        entityId: params.id,
        targetEmployeeId: oldRecord.employeeId,
        afterJson: JSON.stringify({
          oldRecordId: params.id,
          newRecordId: nr.id,
          oldValue: { punchTime: oldRecord.punchTime.toISOString(), punchType: oldRecord.punchType },
          newValue: { punchTime, punchType },
          reason: reason || '管理端編輯',
        }),
        ipAddress: req.headers.get('x-forwarded-for') || null,
        userAgent: req.headers.get('user-agent') || null,
      },
    })
    return nr
  })

  return NextResponse.json({ ok: true, record: { id: newRecord.id } })
}
