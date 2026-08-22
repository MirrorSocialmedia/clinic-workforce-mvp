import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { handleRoute } from '@/lib/api-guard'
import { toHKDateStr } from '@/lib/hk-date'
import { prisma } from '@/lib/prisma'

// ============================================================
// POST /api/cost-cases/implant — Create LAB cost case with materials
// ★ 2026-08-22：路徑名歷史原因（原植牙專用材料錄入）— IMPLANT 併入 LAB 後
//   LAB / INVISALIGN 都用呢條 route 寫 CostCaseMaterial（計價 = 材料明細總和）
// Roles: OWNER, MANAGER
// Body: { providerId, clinicId, patientCode, patientName?,
//         orderedAt, itemType?, dsaName?,
//         receivedAt?, appointmentAt?,
//         materials: [{ materialName, qty, unitPrice? }] }
// ★ B1: 材料單價按 name + orderedAt resolve
// ★ MD-K: 支持單價覆寫 + audit 記錄
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  return handleRoute('cost-cases/implant', async () => {
    const { session } = auth

  const body = await req.json()
  const {
    providerId, clinicId, patientCode, patientName,
    orderedAt, itemType, dsaName,
    receivedAt, appointmentAt,
    materials,
    labId, labOther, labOrderNo, // ★ 2026-08-22（拍板②）：LAB / INVISALIGN 都經呢條 — 保留工場資訊（C 區工場欄）
    billExtId, billCode, billItemEleId, // ★ MD-K: 由帳單新增
  } = body

  if (!providerId || !clinicId || !patientCode || !orderedAt || !materials || !Array.isArray(materials)) {
    return NextResponse.json(
      { error: 'providerId, clinicId, patientCode, orderedAt, materials[] are required' },
      { status: 400 }
    )
  }

  // Validate material quantities are positive integers
  for (const mat of materials) {
    const qty = mat.qty
    if (!Number.isInteger(qty) || qty < 1) {
      return NextResponse.json(
        { error: `材料「${mat.materialName}」嘅數量必須為正整數` },
        { status: 400 }
      )
    }
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

  const priceMap = new Map<string, { id: string; price: number | null }>()
  for (const r of rows) {
    if (!priceMap.has(r.name)) {
      priceMap.set(r.name, { id: r.id, price: r.unitPrice != null ? Number(r.unitPrice) : null })
    }
  }

  // Validate: materials with no master price must have user-provided price
  for (const mat of materials) {
    const resolved = priceMap.get(mat.materialName)
    if (!resolved) {
      return NextResponse.json(
        { error: `材料「${mat.materialName}」喺 ${orderedAt} 冇生效記錄` },
        { status: 400 }
      )
    }
    // ★ MD-K: 主檔冇價 → 用戶必填單價
    if (resolved.price === null && mat.unitPrice == null) {
      return NextResponse.json(
        { error: `材料「${mat.materialName}」主檔未有價，請手動填寫單價` },
        { status: 400 }
      )
    }
  }

  // Build material line items with snapshot prices + override tracking
  let totalBaseCost = 0
  const materialData: any[] = []
  const auditRecords: any[] = [] // ★ MD-K: audit 記錄

  for (const mat of materials) {
    const resolved = priceMap.get(mat.materialName)!
    const masterPrice = resolved.price
    const userPrice = mat.unitPrice != null ? Number(mat.unitPrice) : null
    
    // ★ MD-K: Determine final price + override flag
    let unitPriceUsed: number
    let isPriceOverridden = false
    
    if (masterPrice != null) {
      // 主檔有價
      if (userPrice != null && userPrice !== masterPrice) {
        // 用戶覆寫
        unitPriceUsed = userPrice
        isPriceOverridden = true
      } else {
        // 用主檔價
        unitPriceUsed = masterPrice
      }
    } else {
      // 主檔冇價 → 用用戶價（已驗證必填）
      unitPriceUsed = userPrice!
    }
    
    const qty = mat.qty || 1
    const subtotal = Number((unitPriceUsed * qty).toFixed(2))
    totalBaseCost += subtotal
    
    materialData.push({
      materialItemId: resolved.id,
      qty,
      unitPriceUsed,
      isPriceOverridden,
      subtotal,
    })
    
    // ★ MD-K: 收集 audit 記錄
    if (isPriceOverridden || masterPrice === null) {
      auditRecords.push({
        materialName: mat.materialName,
        materialItemId: resolved.id,
        masterPrice: masterPrice,
        usedPrice: unitPriceUsed,
        overridden: isPriceOverridden,
        reason: isPriceOverridden ? '用戶覆寫單價' : '主檔未有價',
      })
    }
  }

  totalBaseCost = Number(totalBaseCost.toFixed(2))

  // Create cost case with materials in a transaction
  const caseData = await prisma.costCase.create({
    data: {
      providerId,
      clinicId,
      category: 'LAB', // ★ 2026-08-22：IMPLANT 併入 LAB（植牙個案由 itemType 表達）
      patientCode,
      patientName: patientName || null,
      orderedAt: new Date(orderedAt),
      itemType: itemType || null,
      dsaName: dsaName || null,
      labId: labId || null,
      labOther: labOther || null,
      labOrderNo: labOrderNo || null,
      baseCost: totalBaseCost,
      finalCost: totalBaseCost, // ★ 材料明細計價，唔套工場折扣（2026-08-22 起 LAB/INVISALIGN 通用）
      receivedAt: receivedAt ? new Date(receivedAt) : null,
      appointmentAt: appointmentAt ? new Date(appointmentAt) : null,
      billExtId: billExtId || null,
      billCode: billCode || null,
      billItemEleId: billItemEleId || null,
      source: billExtId ? 'BILL_LINKED' : 'MANUAL',
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

  // ★ MD-K: Audit log with material override details
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_CREATE',
      entity: 'CostCase',
      entityId: caseData.id,
      clinicId,
      beforeJson: null,
      afterJson: JSON.stringify({
        providerId, clinicId, category: 'LAB', patientCode,
        baseCost: totalBaseCost, materialCount: materialData.length,
        materialAudits: auditRecords,
      }),
      notes: `新增 LAB 成本記錄（材料計價）: ${patientCode} $${totalBaseCost} (${materialData.length} 項材料)${auditRecords.length > 0 ? ` [${auditRecords.length} 項單價異常]` : ''} (${periodMonth})`,
    },
  } as any)

  const result = {
    ...caseData,
    baseCost: caseData.baseCost ? Number(caseData.baseCost) : null,
    finalCost: caseData.finalCost ? Number(caseData.finalCost) : null,
    materials: caseData.materials.map(m => ({
      ...m,
      unitPriceUsed: Number(m.unitPriceUsed),
      isPriceOverridden: m.isPriceOverridden,
      subtotal: Number(m.subtotal),
    })),
  }

  return NextResponse.json({ case: result }, { status: 201 })
  })
}
