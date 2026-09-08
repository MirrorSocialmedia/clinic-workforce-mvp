import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { handleRoute } from '@/lib/api-guard'
import { toHKDateStr } from '@/lib/hk-date'
import { prisma } from '@/lib/prisma'
import { resolveMaterials } from '@/lib/cost-entry/resolve-materials'

// ============================================================
// POST /api/cost-cases/implant — Create IMPLANT cost case with materials
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
    billExtId, billCode, billItemEleId, // ★ MD-K: 由帳單新增
    // ★ 2026-09-02 cwm-costnote：個案備註 — 命名 caseNote 避免同 materials[].note（材料名）混
    note: caseNote,
  } = body

  if (!providerId || !clinicId || !patientCode || !orderedAt || !materials || !Array.isArray(materials)) {
    return NextResponse.json(
      { error: 'providerId, clinicId, patientCode, orderedAt, materials[] are required' },
      { status: 400 }
    )
  }

  // ★ 2026-09-02 cwm-costnote：備註最多 200 字（前端 maxLength 繞得過，後端兜底）
  if (caseNote != null && String(caseNote).length > 200) {
    return NextResponse.json({ error: '備註最多 200 字' }, { status: 400 })
  }

  // ★ 2026-08-27 拍板①：成本按【到貨日】入月結（同 LAB/INVISALIGN POST 一致）；未到貨 = null
  const periodMonth = receivedAt ? toHKDateStr(receivedAt).slice(0, 7) : null

  // ★ B1 + cwm-payoutcost-20260908 C2：材料單價按 name + orderedAt resolve（抽咗共用 lib，
  //   同 cost-cases/[id] PUT 共享同一套行為 — 單一來源）
  const orderedAtDate = new Date(orderedAt)
  let resolved
  try {
    resolved = await resolveMaterials(materials, orderedAtDate)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
  const { totalBaseCost, materialData, auditRecords } = resolved

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
      finalCost: totalBaseCost, // ★ IMPLANT 唔套工場折扣
      receivedAt: receivedAt ? new Date(receivedAt) : null,
      appointmentAt: appointmentAt ? new Date(appointmentAt) : null,
      // ★ 2026-09-02 cwm-costnote：個案備註（共用 modal 同 LAB 一樣有備註欄 — 唔接會靜默食值）
      note: caseNote?.trim() || null,
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
        providerId, clinicId, category: 'IMPLANT', patientCode,
        baseCost: totalBaseCost, materialCount: materialData.length,
        materialAudits: auditRecords,
        note: caseNote?.trim() || null,
      }),
      notes: `新增 IMPLANT 成本記錄: ${patientCode} $${totalBaseCost} (${materialData.length} 項材料)${auditRecords.length > 0 ? ` [${auditRecords.length} 項單價異常]` : ''} (${periodMonth})`,
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
