import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// POST /api/cost-cases/implant — Create IMPLANT cost case with materials
// Roles: OWNER, MANAGER
// Body: { providerId, clinicId, patientCode, patientName?,
//         orderedAt, itemType?, dsaName?,
//         receivedAt?, appointmentAt?,
//         materials: [{ materialItemId, qty }] }
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json()
  const {
    providerId, clinicId, patientCode, patientName,
    orderedAt, itemType, dsaName,
    receivedAt, appointmentAt,
    materials,
  } = body

  if (!providerId || !clinicId || !patientCode || !orderedAt || !materials || !Array.isArray(materials)) {
    return NextResponse.json(
      { error: 'providerId, clinicId, patientCode, orderedAt, materials[] are required' },
      { status: 400 }
    )
  }

  // Derive periodMonth from orderedAt
  const orderedDate = new Date(orderedAt)
  const periodMonth = `${orderedDate.getFullYear()}-${String(orderedDate.getMonth() + 1).padStart(2, '0')}`

  // Resolve material prices: effectiveFrom DESC, id DESC (tiebreaker)
  const materialItemIds = materials.map((m: any) => m.materialItemId)
  const materialItems = await prisma.materialItem.findMany({
    where: {
      id: { in: materialItemIds },
      isActive: true,
    },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    select: { id: true, unitPrice: true },
  })

  // Group by materialItemId, take the first (most recent)
  const priceMap = new Map<string, number>()
  for (const item of materialItems) {
    if (!priceMap.has(item.id)) {
      priceMap.set(item.id, Number(item.unitPrice))
    }
  }

  // Build material line items with snapshot prices
  let totalBaseCost = 0
  const materialData: any[] = []

  for (const mat of materials) {
    const unitPriceUsed = priceMap.get(mat.materialItemId)
    if (unitPriceUsed == null) {
      return NextResponse.json(
        { error: `Material ${mat.materialItemId} not found or inactive` },
        { status: 400 }
      )
    }
    const qty = mat.qty || 1
    const subtotal = Number((unitPriceUsed * qty).toFixed(2))
    totalBaseCost += subtotal
    materialData.push({
      materialItemId: mat.materialItemId,
      qty,
      unitPriceUsed,
      subtotal,
    })
  }

  totalBaseCost = Number(totalBaseCost.toFixed(2))

  // Create cost case with materials in a transaction
  const caseData = await prisma.costCase.create({
    data: {
      providerId,
      clinicId,
      category: 'IMPLANT',
      patientCode,
      patientName: patientName || null,
      orderedAt: new Date(orderedAt),
      itemType: itemType || null,
      dsaName: dsaName || null,
      baseCost: totalBaseCost,
      finalCost: totalBaseCost, // IMPLANT has no discount
      receivedAt: receivedAt ? new Date(receivedAt) : null,
      appointmentAt: appointmentAt ? new Date(appointmentAt) : null,
      status: 'PRICED',
      periodMonth,
      createdBy: session.userId,
      materials: {
        create: materialData,
      },
    },
    include: {
      materials: true,
    },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_CREATE',
      entity: 'CostCase',
      entityId: caseData.id,
      clinicId,
      beforeJson: null,
      afterJson: JSON.stringify({
        providerId, clinicId, category: 'IMPLANT', patientCode,
        baseCost: totalBaseCost, materialCount: materialData.length,
      }),
      notes: `新增 IMPLANT 成本記錄: ${patientCode} $${totalBaseCost} (${materialData.length} 項材料) (${periodMonth})`,
    },
  } as any)

  const result = {
    ...caseData,
    baseCost: caseData.baseCost ? Number(caseData.baseCost) : null,
    finalCost: caseData.finalCost ? Number(caseData.finalCost) : null,
    materials: caseData.materials.map(m => ({
      ...m,
      unitPriceUsed: Number(m.unitPriceUsed),
      subtotal: Number(m.subtotal),
    })),
  }

  return NextResponse.json({ case: result }, { status: 201 })
}
