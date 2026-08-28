import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { toHKDateStr } from '@/lib/hk-date'

// ============================================================
// GET /api/material-items — List material items
// Roles: OWNER, MANAGER
// Query: ?name=&isActive=
// ★ 返最新一個生效價格（effectiveFrom DESC, id DESC）
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const name = searchParams.get('name')
  const isActive = searchParams.get('isActive')
  // ★ 2026-08-28 (cwm-matedit-t1): ?all=1 → 返版本鏈全部行（含停用/已到期），材料主檔列表用；
  //   預設行為唔變（只回當前生效），錄入下拉等 consumer 照用。
  const allVersions = searchParams.get('all') === '1'

  const where: any = {}
  if (!allVersions) {
    // ★ B3: 只回當前生效嘅材料
    where.isActive = true
    where.effectiveFrom = { lte: new Date() }
    where.OR = [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }]
  }
  if (name) where.name = { contains: name, mode: 'insensitive' }

  // Get all items with their latest price
  const items = await prisma.materialItem.findMany({
    where,
    orderBy: allVersions
      ? [{ name: 'asc' }, { effectiveFrom: 'desc' }, { id: 'desc' }]
      : [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  })

  // ★ B3: 去重 key 只用 name（同名唔同生效日會去重）
  const seen = new Set<string>()
  const uniqueItems: typeof items = []

  for (const item of items) {
    const key = item.name
    if (!seen.has(key)) {
      seen.add(key)
      uniqueItems.push(item)
    }
  }

  // Get the latest active price per material name
  const nameMap = new Map<string, any>()
  for (const item of items) {
    if (!nameMap.has(item.name) || item.effectiveFrom > nameMap.get(item.name).effectiveFrom) {
      nameMap.set(item.name, item)
    }
  }

  const latestItems = Array.from(nameMap.values())

  return jsonNoStore({
    items: latestItems.map(i => ({
      ...i,
      unitPrice: i.unitPrice != null ? Number(i.unitPrice) : null,
    })),
    allRecords: items.map(i => ({
      ...i,
      unitPrice: i.unitPrice != null ? Number(i.unitPrice) : null,
    })),
  })
}

// ============================================================
// POST /api/material-items — Create a material item
// Roles: OWNER (provider_payout via perm override)
// Body: { name, unitPrice, effectiveFrom, effectiveTo?, isActive? }
// ★ 只准新增唔准改舊記錄（同 ProviderCommission 一樣）
// ============================================================
export async function POST(req: NextRequest) {
  const permCheck = await requirePerm(req, 'provider_payout')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const body = await req.json()
  const { name, unitPrice, effectiveFrom, effectiveTo, isActive } = body

  if (!name || !effectiveFrom) {
    return NextResponse.json({ error: 'name, effectiveFrom are required' }, { status: 400 })
  }

  const newEffFrom = new Date(effectiveFrom)
  if (isNaN(newEffFrom.getTime())) {
    return NextResponse.json({ error: 'effectiveFrom 係無效日期' }, { status: 400 })
  }

  // ★ 2026-08-28 (cwm-matedit-t1): 生效日守衛 — 同名最新版本（isActive，取 effectiveFrom 最大）
  //   之後先可以開新版本；否則版本鏈倒走，歷史 resolve 會撈錯價。
  const existingActive = await prisma.materialItem.findFirst({
    where: { name, isActive: true },
    orderBy: { effectiveFrom: 'desc' },
    take: 1,
  })

  if (existingActive && newEffFrom <= existingActive.effectiveFrom) {
    return NextResponse.json(
      { error: `生效日要遲過現有版本（${toHKDateStr(existingActive.effectiveFrom)}）` },
      { status: 400 },
    )
  }

  // If there's an active item with the same name, auto-set its effectiveTo
  if (existingActive && !existingActive.effectiveTo) {
    await prisma.materialItem.update({
      where: { id: existingActive.id },
      data: { effectiveTo: newEffFrom },
    })
  }

  const item = await prisma.materialItem.create({
    data: {
      name,
      unitPrice: unitPrice != null ? Number(unitPrice) : null,
      effectiveFrom: newEffFrom,
      effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
      isActive: isActive ?? true,
    },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'MATERIAL_ITEM_CREATE',
      entity: 'MaterialItem',
      entityId: item.id,
      beforeJson: null,
      afterJson: JSON.stringify({ name, unitPrice: unitPrice != null ? Number(unitPrice) : null, effectiveFrom }),
      notes: `新增材料項目: ${name}${unitPrice != null ? ' $' + Number(unitPrice) : ' (冇定價)'}`,
    },
  } as any)

  return NextResponse.json({
    item: { ...item, unitPrice: item.unitPrice != null ? Number(item.unitPrice) : null },
  }, { status: 201 })
}
