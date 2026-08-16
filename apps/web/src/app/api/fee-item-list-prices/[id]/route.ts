export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { prisma } from '@/lib/prisma'

// ownership-ok: FeeItemListPrice 係全公司共用主檔，冇 clinic/employee 歸屬

export async function PATCH(
 req: NextRequest,
 { params }: { params: { id: string } },
) {
 const auth = await requireAuth(req, 'PATCH', req.url)
 if (isAuthError(auth)) return auth.error

 const before = await prisma.feeItemListPrice.findUnique({ where: { id: params.id } })
 if (!before) return jsonNoStore({ error: '標準價記錄不存在' }, { status: 404 })

 const body = await req.json().catch(() => ({}))
 const { label, listPrice, effectiveFrom, effectiveTo } = body

 const item = await prisma.feeItemListPrice.update({
  where: { id: params.id },
  data: {
   ...(label !== undefined && { label }),
   ...(listPrice !== undefined && { listPrice: Number(listPrice) }),
   ...(effectiveFrom !== undefined && { effectiveFrom: new Date(effectiveFrom) }),
   ...(effectiveTo !== undefined && { effectiveTo: effectiveTo ? new Date(effectiveTo) : null }),
  },
 })

 await prisma.auditLog.create({ data: {
  actorId: auth.session!.userId,
  action: 'FEE_ITEM_LIST_PRICE_SET',
  entity: 'FeeItemListPrice',
  entityId: item.id,
  notes: `更新標準價：${item.label}（${item.feeItemCode}）${Number(before.listPrice)} → ${Number(item.listPrice)}`,
  beforeJson: JSON.stringify(before),
  afterJson: JSON.stringify(item),
 }})

 return jsonNoStore({ item })
}

export async function DELETE(
 req: NextRequest,
 { params }: { params: { id: string } },
) {
 const auth = await requireAuth(req, 'DELETE', req.url)
 if (isAuthError(auth)) return auth.error

 const row = await prisma.feeItemListPrice.findUnique({ where: { id: params.id } })
 if (!row) return jsonNoStore({ error: '標準價記錄不存在' }, { status: 404 })

 // 剷走 DELETE — 改用 effectiveTo 軟停用
 return jsonNoStore(
  { error: '標準價唔准刪除。如要作廢請設 effectiveTo 生效日。' },
  { status: 405 }
 )
}
