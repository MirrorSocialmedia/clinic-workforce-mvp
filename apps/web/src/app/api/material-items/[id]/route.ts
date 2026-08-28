// ownership-ok: MaterialItem 係全公司共用主檔，冇 clinic/employee 歸屬；
// route 已經 requirePerm('provider_payout') = OWNER only（跟 POST 一致）
import { NextRequest, NextResponse } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { toHKDateStr } from '@/lib/hk-date'

// ============================================================
// PUT /api/material-items/:id — Update a material item version
// Roles: OWNER (provider_payout via perm override)
// Body: { isActive?: boolean, effectiveTo?: string|null }
// ★ 2026-08-28 (cwm-matedit-t1): 只准改 isActive / effectiveTo。
//   name / unitPrice 一律忽略（唔准 UPDATE name：implant resolve 靠 name、
//   匯出靠 id 反查當前名；改價/更名 = POST 新版本走版本鏈）。
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const permCheck = await requirePerm(req, 'provider_payout')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const { id } = await params
  const existing = await prisma.materialItem.findUnique({ where: { id } })

  if (!existing) {
    return jsonNoStore({ error: '搵唔到記錄' }, { status: 404 })
  }

  const body = await req.json()
  const { isActive, effectiveTo } = body

  const data: any = {}
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') {
      return NextResponse.json({ error: 'isActive 必須係 boolean' }, { status: 400 })
    }
    data.isActive = isActive
  }
  if (effectiveTo !== undefined) {
    if (effectiveTo === null) {
      data.effectiveTo = null
    } else {
      const d = new Date(effectiveTo)
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: 'effectiveTo 必須係有效日期（YYYY-MM-DD）' }, { status: 400 })
      }
      data.effectiveTo = d
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: '冇可更新欄（淨係支持 isActive / effectiveTo）' }, { status: 400 })
  }

  const updated = await prisma.materialItem.update({ where: { id }, data })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'MATERIAL_ITEM_UPDATE',
      entity: 'MaterialItem',
      entityId: id,
      beforeJson: JSON.stringify({ isActive: existing.isActive, effectiveTo: existing.effectiveTo ? toHKDateStr(existing.effectiveTo) : null }),
      afterJson: JSON.stringify({ isActive: updated.isActive, effectiveTo: updated.effectiveTo ? toHKDateStr(updated.effectiveTo) : null }),
      notes: `更新材料項目: ${updated.name}（isActive=${updated.isActive}${updated.effectiveTo ? '，effectiveTo=' + toHKDateStr(updated.effectiveTo) : ''}）`,
    },
  } as any)

  return jsonNoStore({
    item: { ...updated, unitPrice: updated.unitPrice != null ? Number(updated.unitPrice) : null },
  })
}
