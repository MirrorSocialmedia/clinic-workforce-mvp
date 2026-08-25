import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { toHKDateStr } from '@/lib/hk-date'

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
    baseCost, receivedAt, appointmentAt, status,
    // ★ 2026-08-25 拍板③：全欄可改 — providerId / clinicId / category
    //   ⚠️ 呢三個直接改變【拆帳歸屬】同【成本分類】，一定要入 audit
    providerId, clinicId, category,
    // ★ 2026-08-25 拍板①：重做（REDO）
    redoAt, redoReason,
  } = body

  // ★ Q2: Look up discount from LabMonthlyDiscount table (ignore body discountPct)
  const effectiveLabId = labId !== undefined ? (labId || null) : existing.labId
  const effectivePeriodMonth = orderedAt !== undefined
    ? toHKDateStr(orderedAt).slice(0, 7)
    : existing.periodMonth

  // ★ 2026-08-25 守衛①：改醫生／診所要驗存在性（FK 撞 = 400 唔係 500）
  if (providerId !== undefined && providerId !== existing.providerId) {
    const ok = await prisma.provider.count({ where: { id: providerId, isActive: true } })
    if (!ok) return jsonNoStore({ error: '醫生唔存在或已停用' }, { status: 400 })
  }
  if (clinicId !== undefined && clinicId !== existing.clinicId) {
    const ok = await prisma.clinic.count({ where: { id: clinicId } })
    if (!ok) return jsonNoStore({ error: '診所唔存在' }, { status: 400 })
  }

  // ★ 2026-08-25 守衛②：category 只准三個值
  if (category !== undefined && !['LAB', 'IMPLANT', 'INVISALIGN'].includes(category)) {
    return jsonNoStore({ error: 'category 唔合法' }, { status: 400 })
  }

  // ★ 2026-08-25 守衛③：改落單日會換 periodMonth — 目標月份已 LOCKED 唔准改
  //   ⚠️ PayoutRun status 實值只有 DRAFT | LOCKED（2026-08-25 grep 確認；
  //      MD 寫嘅 EXPORTED 係 PayrollRun 嘅狀態，唔係 PayoutRun 嘅）
  if (effectivePeriodMonth !== existing.periodMonth) {
    const lockedRun = await prisma.payoutRun.findFirst({
      where: { periodMonth: effectivePeriodMonth, status: 'LOCKED' },
      select: { id: true },
    })
    if (lockedRun) {
      return jsonNoStore(
        { error: `${effectivePeriodMonth} 已出月結，唔可以改到嗰個月` }, { status: 409 })
    }
  }

  // ★ 2026-08-25 拍板①：REDO 守衛 — 重做日期 + 原因都要有（月尾對數要查得返）
  const nextStatus = status !== undefined ? status : existing.status
  const nextRedoAt = redoAt !== undefined ? redoAt : (existing.redoAt ?? null)
  if (nextStatus === 'REDO') {
    if (!nextRedoAt) {
      return jsonNoStore({ error: '重做要填重做日期' }, { status: 400 })
    }
    const nextRedoReason = redoReason !== undefined ? redoReason : existing.redoReason
    if (!nextRedoReason || !String(nextRedoReason).trim()) {
      return jsonNoStore({ error: '重做要填原因' }, { status: 400 })
    }
  }
  let discountPctNum: number | null = null
  if (effectiveLabId) {
    const d = await prisma.labMonthlyDiscount.findUnique({
      where: { labId_periodMonth: { labId: effectiveLabId, periodMonth: effectivePeriodMonth } },
      select: { discountPct: true },
    })
    discountPctNum = d ? Number(d.discountPct) : null
  }

  // Compute finalCost if baseCost or labId changed
  let finalCost: number | null = existing.finalCost ? Number(existing.finalCost) : null

  if (baseCost != null || labId !== undefined) {
    const bc = baseCost != null ? Number(baseCost) : (existing.baseCost ? Number(existing.baseCost) : null)

    if (bc != null && discountPctNum != null) {
      finalCost = Number((bc * (100 - discountPctNum) / 100).toFixed(2))
    } else if (bc != null) {
      finalCost = bc
    }
  }

  const data: any = {}
  if (patientCode !== undefined) data.patientCode = patientCode
  if (patientName !== undefined) data.patientName = patientName
  if (orderedAt !== undefined) data.orderedAt = new Date(orderedAt)
  // ★ 2026-08-25：改落單日 → periodMonth 跟住變（守衛③已驗證目標月未鎖）
  if (orderedAt !== undefined && effectivePeriodMonth !== existing.periodMonth) {
    data.periodMonth = effectivePeriodMonth
  }
  if (itemType !== undefined) data.itemType = itemType
  if (labId !== undefined) data.labId = labId
  if (labOrderNo !== undefined) data.labOrderNo = labOrderNo
  if (dsaName !== undefined) data.dsaName = dsaName
  if (baseCost !== undefined) data.baseCost = baseCost != null ? Number(baseCost) : null
  // ★ Q2: discountPct now from table, not body
  if (discountPctNum !== (existing.discountPct ? Number(existing.discountPct) : null)) data.discountPct = discountPctNum
  if (finalCost !== existing.finalCost?.toNumber()) data.finalCost = finalCost != null ? finalCost : null
  if (receivedAt !== undefined) data.receivedAt = receivedAt ? new Date(receivedAt) : null
  if (appointmentAt !== undefined) data.appointmentAt = appointmentAt ? new Date(appointmentAt) : null
  if (status !== undefined) data.status = status
  if (providerId !== undefined) data.providerId = providerId
  if (clinicId !== undefined) data.clinicId = clinicId
  if (category !== undefined) data.category = category
  if (redoAt !== undefined) data.redoAt = redoAt ? new Date(redoAt) : null
  if (redoReason !== undefined) data.redoReason = redoReason || null

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
        // ★ 2026-08-25：拆帳歸屬 / 成本分類欄入 audit（拍板③）
        providerId: existing.providerId,
        clinicId: existing.clinicId,
        category: existing.category,
        // ★ 2026-08-25：重做欄（拍板①）
        redoAt: existing.redoAt,
        redoReason: existing.redoReason,
      }),
      afterJson: JSON.stringify({
        baseCost: updated.baseCost ? Number(updated.baseCost) : null,
        finalCost: updated.finalCost ? Number(updated.finalCost) : null,
        status: updated.status,
        providerId: updated.providerId,
        clinicId: updated.clinicId,
        category: updated.category,
        redoAt: updated.redoAt,
        redoReason: updated.redoReason,
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
