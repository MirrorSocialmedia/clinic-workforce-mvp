import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// PUT /api/cost-cases/:id — Update a cost case
// Roles: OWNER, MANAGER
// ⚠️ lockedByRunId != null → 409「已出月結，請用下期調整」
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { id } = await params
  const existing = await prisma.costCase.findUnique({ where: { id } })

  if (!existing) {
    return jsonNoStore({ error: '搵唔到記錄' }, { status: 404 })
  }

  // ★ 鎖定後唔准改
  if (existing.lockedByRunId != null) {
    return jsonNoStore({ error: '已出月結，請用下期調整' }, { status: 409 })
  }

  const body = await req.json()
  const {
    patientCode, patientName, orderedAt, itemType,
    labId, labOrderNo, dsaName,
    baseCost, discountPct, receivedAt, appointmentAt, status,
  } = body

  // Compute finalCost if baseCost or discountPct changed
  let finalCost: number | null = existing.finalCost ? Number(existing.finalCost) : null

  if (baseCost != null || discountPct != null) {
    const bc = baseCost != null ? Number(baseCost) : (existing.baseCost ? Number(existing.baseCost) : null)
    const dp = discountPct != null ? Number(discountPct) : (existing.discountPct ? Number(existing.discountPct) : null)

    if (bc != null && dp != null) {
      finalCost = Number((bc * (100 - dp) / 100).toFixed(2))
    } else if (bc != null) {
      finalCost = bc
    }
  }

  const data: any = {}
  if (patientCode !== undefined) data.patientCode = patientCode
  if (patientName !== undefined) data.patientName = patientName
  if (orderedAt !== undefined) data.orderedAt = new Date(orderedAt)
  if (itemType !== undefined) data.itemType = itemType
  if (labId !== undefined) data.labId = labId
  if (labOrderNo !== undefined) data.labOrderNo = labOrderNo
  if (dsaName !== undefined) data.dsaName = dsaName
  if (baseCost !== undefined) data.baseCost = baseCost != null ? Number(baseCost) : null
  if (discountPct !== undefined) data.discountPct = discountPct != null ? Number(discountPct) : null
  if (finalCost !== existing.finalCost?.toNumber()) data.finalCost = finalCost != null ? finalCost : null
  if (receivedAt !== undefined) data.receivedAt = receivedAt ? new Date(receivedAt) : null
  if (appointmentAt !== undefined) data.appointmentAt = appointmentAt ? new Date(appointmentAt) : null
  if (status !== undefined) data.status = status

  const updated = await prisma.costCase.update({
    where: { id },
    data,
    include: {
      lab: { select: { id: true, name: true } },
    },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_UPDATE',
      entity: 'CostCase',
      entityId: id,
      clinicId: existing.clinicId,
      beforeJson: JSON.stringify({
        baseCost: existing.baseCost ? Number(existing.baseCost) : null,
        finalCost: existing.finalCost ? Number(existing.finalCost) : null,
        status: existing.status,
      }),
      afterJson: JSON.stringify({
        baseCost: updated.baseCost ? Number(updated.baseCost) : null,
        finalCost: updated.finalCost ? Number(updated.finalCost) : null,
        status: updated.status,
      }),
      notes: `更新成本記錄: ${existing.category} ${existing.patientCode}`,
    },
  } as any)

  const result = {
    ...updated,
    baseCost: updated.baseCost ? Number(updated.baseCost) : null,
    discountPct: updated.discountPct ? Number(updated.discountPct) : null,
    finalCost: updated.finalCost ? Number(updated.finalCost) : null,
  }

  return jsonNoStore({ case: result })
}

// ============================================================
// DELETE /api/cost-cases/:id — Soft void a cost case
// Roles: OWNER, MANAGER
// ★ soft: status='VOID', 唔會消失
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { id } = await params
  const existing = await prisma.costCase.findUnique({ where: { id } })

  if (!existing) {
    return jsonNoStore({ error: '搵唔到記錄' }, { status: 404 })
  }

  // ★ 鎖定後唔准改
  if (existing.lockedByRunId != null) {
    return jsonNoStore({ error: '已出月結，請用下期調整' }, { status: 409 })
  }

  if (existing.status === 'VOID') {
    return jsonNoStore({ error: '已經係 VOID 狀態' }, { status: 409 })
  }

  const updated = await prisma.costCase.update({
    where: { id },
    data: { status: 'VOID' },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_VOID',
      entity: 'CostCase',
      entityId: id,
      clinicId: existing.clinicId,
      beforeJson: JSON.stringify({
        status: existing.status,
        baseCost: existing.baseCost ? Number(existing.baseCost) : null,
        finalCost: existing.finalCost ? Number(existing.finalCost) : null,
      }),
      afterJson: JSON.stringify({ status: 'VOID' }),
      notes: `作廢成本記錄: ${existing.category} ${existing.patientCode} (${existing.periodMonth})`,
    },
  } as any)

  return jsonNoStore({ case: updated })
}
