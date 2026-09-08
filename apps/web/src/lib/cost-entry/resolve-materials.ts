import { prisma } from '@/lib/prisma'

export interface MaterialInput {
  materialName: string
  qty: number
  unitPrice?: number | null
  note?: string | null
}

export interface ResolvedMaterials {
  totalBaseCost: number
  materialData: {
    materialItemId: string
    qty: number
    unitPriceUsed: number
    isPriceOverridden: boolean
    subtotal: number
    note: string | null
  }[]
  auditRecords: any[]
}

/**
 * ★ cwm-payoutcost-20260908 C2：材料名 + 落單日 → 單價快照
 * 由 api/cost-cases/implant/route.ts:60-152 原封搬過嚟，行為必須完全一樣。
 * 兩個 caller：implant POST（新增）／cost-cases/[id] PUT（修改）。
 * 失敗一律 throw Error(message)，caller 轉 400。
 */
export async function resolveMaterials(
  materials: MaterialInput[],
  orderedAt: Date,
): Promise<ResolvedMaterials> {
  for (const mat of materials) {
    if (!Number.isInteger(mat.qty) || mat.qty < 1) {
      throw new Error(`材料「${mat.materialName}」嘅數量必須為正整數`)
    }
  }

  const names = materials.map(m => m.materialName)
  const rows = await prisma.materialItem.findMany({
    where: {
      name: { in: names },
      isActive: true,
      effectiveFrom: { lte: orderedAt },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: orderedAt } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  })

  const priceMap = new Map<string, { id: string; price: number | null }>()
  for (const r of rows) {
    if (!priceMap.has(r.name)) {
      priceMap.set(r.name, { id: r.id, price: r.unitPrice != null ? Number(r.unitPrice) : null })
    }
  }

  for (const mat of materials) {
    const resolved = priceMap.get(mat.materialName)
    if (!resolved) throw new Error(`材料「${mat.materialName}」喺 ${orderedAt.toISOString().slice(0, 10)} 冇生效記錄`)
    if (resolved.price === null && mat.unitPrice == null) {
      throw new Error(`材料「${mat.materialName}」主檔未有價，請手動填寫單價`)
    }
  }

  let totalBaseCost = 0
  const materialData: ResolvedMaterials['materialData'] = []
  const auditRecords: any[] = []

  for (const mat of materials) {
    const resolved = priceMap.get(mat.materialName)!
    const masterPrice = resolved.price
    const userPrice = mat.unitPrice != null ? Number(mat.unitPrice) : null

    let unitPriceUsed: number
    let isPriceOverridden = false
    if (masterPrice != null) {
      if (userPrice != null && userPrice !== masterPrice) {
        unitPriceUsed = userPrice
        isPriceOverridden = true
      } else {
        unitPriceUsed = masterPrice
      }
    } else {
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
      note: mat.note?.trim() || null,
    })

    if (isPriceOverridden || masterPrice === null) {
      auditRecords.push({
        materialName: mat.materialName,
        materialItemId: resolved.id,
        masterPrice,
        usedPrice: unitPriceUsed,
        overridden: isPriceOverridden,
        reason: isPriceOverridden ? '用戶覆寫單價' : '主檔未有價',
      })
    }
  }

  return { totalBaseCost: Number(totalBaseCost.toFixed(2)), materialData, auditRecords }
}
