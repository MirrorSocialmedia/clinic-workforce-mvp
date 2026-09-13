import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { handleRoute } from '@/lib/api-guard'
import { prisma } from '@/lib/prisma'
import { resolveMaterials } from '@/lib/cost-entry/resolve-materials'
import { deriveCostPeriod } from '@/lib/cost-entry/period-month'

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
    receivedAt: _ignoredReceivedAt, appointmentAt: _ignoredAppointmentAt,
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

  // ★★★ cwm-implantdate-20260913 拍板乙：植牙冇「到貨」概念（材料即場用），
  //   UI 已剷走到貨日欄 → 後端【強制】receivedAt = orderedAt。
  //   ⚠️ 一定要【強制】唔可以做 default —— 前端唔傳 receivedAt 嘅話，
  //      原本邏輯會俾 null，periodMonth 變 null，成本永遠唔入月結（engine.ts:390 撈唔到）。
  //   ⚠️ 覆診日（appointmentAt）一律 null —— 全 repo 只有成本錄入頁顯示，冇引擎 consumer。
  //   （取代 2026-08-27 拍板①嘅「跟到貨日」—— 只針對 IMPLANT；LAB 路徑唔受影響。）
  const { receivedAt: effectiveReceivedAt, periodMonth } = deriveCostPeriod('IMPLANT', orderedAt, _ignoredReceivedAt)

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
      receivedAt: effectiveReceivedAt,   // ★ 強制 = 落單日（deriveCostPeriod('IMPLANT', ...)）
      appointmentAt: null,                // ★ 植牙唔用覆診日
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
