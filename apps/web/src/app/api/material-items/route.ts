import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

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

  // ★ B3: 只回當前生效嘅材料
  const activeWhere: any = {
    isActive: true,
    effectiveFrom: { lte: new Date() },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
  }
  if (name) activeWhere.name = { contains: name, mode: 'insensitive' }

  // Get all items with their latest price
  const items = await prisma.materialItem.findMany({
    where: activeWhere,
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
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
      unitPrice: Number(i.unitPrice),
    })),
    allRecords: items.map(i => ({
      ...i,
      unitPrice: Number(i.unitPrice),
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

  if (!name || unitPrice == null || !effectiveFrom) {
    return NextResponse.json({ error: 'name, unitPrice, effectiveFrom are required' }, { status: 400 })
  }

  // If there's an active item with the same name, auto-set its effectiveTo
  const existingActive = await prisma.materialItem.findFirst({
    where: { name, isActive: true },
    orderBy: { effectiveFrom: 'desc' },
    take: 1,
  })

  if (existingActive && !existingActive.effectiveTo) {
    await prisma.materialItem.update({
      where: { id: existingActive.id },
      data: { effectiveTo: new Date(effectiveFrom) },
    })
  }

  const item = await prisma.materialItem.create({
    data: {
      name,
      unitPrice: Number(unitPrice),
      effectiveFrom: new Date(effectiveFrom),
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
      afterJson: JSON.stringify({ name, unitPrice: Number(unitPrice), effectiveFrom }),
      notes: `新增材料項目: ${name} $${Number(unitPrice)}`,
    },
  } as any)

  return NextResponse.json({
    item: { ...item, unitPrice: Number(item.unitPrice) },
  }, { status: 201 })
}
