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
// Body: { isActive?: boolean, effectiveFrom?: string, effectiveTo?: string|null }
// ★ 2026-08-28 (cwm-matedit-t1): 只准改 isActive / effectiveTo。
// ★ 2026-09-08 (cwm-payoutcost-20260908 B1): 加 effectiveFrom，配三條版本鏈守衛。
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
  const { isActive, effectiveTo, effectiveFrom } = body

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

  // ★ cwm-payoutcost-20260908 B1：生效日可改，但唔准令版本鏈倒走
  //   （倒走 = 同名版本嘅 effectiveFrom 次序反轉 → implant/route.ts:64-70 嘅
  //     `orderBy effectiveFrom desc` resolve 會撈錯版本）
  //   ★ 歷史個案安全：CostCaseMaterial.unitPriceUsed 係快照，改主檔唔會倒流。
  if (effectiveFrom !== undefined) {
    const d = new Date(effectiveFrom)
    if (isNaN(d.getTime())) {
      return NextResponse.json({ error: 'effectiveFrom 必須係有效日期（YYYY-MM-DD）' }, { status: 400 })
    }
    data.effectiveFrom = d
  }

  // ★ cwm-payoutcost-fix-20260908 P0-1：三條守衛【只喺真係改日期時】先跑。
  // ★ cwm-matedate-open-20260909：版本鏈守衛（守衛 2／3）已剷 —— 老細 2026-09-09 拍板。
  //   點解剷得起：CostCaseMaterial.unitPriceUsed 係快照 → 歷史個案唔受影響。
  //   鏈亂咗只有兩個後果，兩個都自己會叫：
  //     重疊 → resolveMaterials 按 effectiveFrom desc / id desc 揀最新（確定性）
  //     有窿 → 錄入時 400「喺 X 冇生效記錄」
  //   守衛擋住嘅係可見可救嘅嘢，但同時擋住咗人手救鏈 → 得不償失。
  //   ★ 淨低守衛 1：唔係政策限制，係自相矛盾防呆（from > to 嘅版本永遠 resolve 唔到）。
  if (effectiveFrom !== undefined || effectiveTo !== undefined) {
    const finalFrom: Date = data.effectiveFrom ?? existing.effectiveFrom
    const finalTo: Date | null =
      data.effectiveTo !== undefined ? data.effectiveTo : existing.effectiveTo
    if (finalTo && finalFrom >= finalTo) {
      return NextResponse.json({ error: '生效日一定要早過到期日' }, { status: 400 })
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: '冇可更新欄（淨係支持 isActive / effectiveFrom / effectiveTo）' }, { status: 400 })
  }

  const updated = await prisma.materialItem.update({ where: { id }, data })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'MATERIAL_ITEM_UPDATE',
      entity: 'MaterialItem',
      entityId: id,
      beforeJson: JSON.stringify({
        isActive: existing.isActive,
        effectiveFrom: toHKDateStr(existing.effectiveFrom),
        effectiveTo: existing.effectiveTo ? toHKDateStr(existing.effectiveTo) : null,
      }),
      afterJson: JSON.stringify({
        isActive: updated.isActive,
        effectiveFrom: toHKDateStr(updated.effectiveFrom),
        effectiveTo: updated.effectiveTo ? toHKDateStr(updated.effectiveTo) : null,
      }),
      notes: `更新材料項目: ${updated.name}（${toHKDateStr(updated.effectiveFrom)} → ${updated.effectiveTo ? toHKDateStr(updated.effectiveTo) : '無限期'}，isActive=${updated.isActive}）`,
    },
  } as any)

  return jsonNoStore({
    item: { ...updated, unitPrice: updated.unitPrice != null ? Number(updated.unitPrice) : null },
  })
}
