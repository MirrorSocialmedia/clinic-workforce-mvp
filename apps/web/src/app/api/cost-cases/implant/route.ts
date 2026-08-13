import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr } from '@/lib/hk-date'
import { prisma } from '@/lib/prisma'

// ============================================================
// POST /api/cost-cases/implant — Create IMPLANT cost case with materials
// Roles: OWNER, MANAGER
// Body: { providerId, clinicId, patientCode, patientName?,
//         orderedAt, itemType?, dsaName?,
//         receivedAt?, appointmentAt?,
//         materials: [{ materialName, qty }] }
// ★ B1: 材料單價按 name + orderedAt resolve（唔係按 id）
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
  const periodMonth = toHKDateStr(orderedAt).slice(0, 7)

  // ★ B1: Resolve material prices by name + orderedAt
  const orderedAtDate = new Date(orderedAt)
  const names = materials.map((m: any) => m.materialName)
  const rows = await prisma.materialItem.findMany({
    where: {
      name: { in: names },
      isActive: true,
      effectiveFrom: { lte: orderedAtDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: orderedAtDate } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  })

  const priceMap = new Map<string, { id: string; price: number }>()
  for (const r of rows) {
    if (!priceMap.has(r.name)) {
      priceMap.set(r.name, { id: r.id, price: Number(r.unitPrice) })
    }
  }

  // Check all materials have a resolved price
  for (const mat of materials) {
    const resolved = priceMap.get(mat.materialName)
    if (!resolved) {
      return NextResponse.json(
        { error: `材料「${mat.materialName}」喺 ${orderedAt} 冇生效價格` },
        { status: 400 }
      )
    }
  }

  // Build material line items with snapshot prices
  let totalBaseCost = 0
  const materialData: any[] = []

  for (const mat of materials) {
    const resolved = priceMap.get(mat.materialName)!
    const unitPriceUsed = resolved.price
    const qty = mat.qty || 1
    const subtotal = Number((unitPriceUsed * qty).toFixed(2))
    totalBaseCost += subtotal
    materialData.push({
      materialItemId: resolved.id, // ★ store resolved id, not user-selected
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
