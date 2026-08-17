import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/labs — List labs
// Roles: OWNER, MANAGER
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const labs = await prisma.lab.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })

  return jsonNoStore({ labs })
}

// ============================================================
// POST /api/labs — Create a lab
// Roles: OWNER (provider_payout via perm override)
// Body: { name, sortOrder? }
// ============================================================
export async function POST(req: NextRequest) {
  const permCheck = await requirePerm(req, 'provider_payout')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const body = await req.json()
  const { name, sortOrder } = body

  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const lab = await prisma.lab.create({
    data: {
      name,
      sortOrder: sortOrder ?? 0,
    },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_CREATE',
      entity: 'Lab',
      entityId: lab.id,
      beforeJson: null,
      afterJson: JSON.stringify({ name }),
      notes: `新增 Lab: ${name}`,
    },
  } as any)

  return NextResponse.json({ lab }, { status: 201 })
}

// ============================================================
// PATCH /api/labs — Rename / deactivate a lab
// Roles: OWNER (provider_payout via perm override)
// Body: { name?, isActive? }
// ============================================================
export async function PATCH(req: NextRequest) {
  const permCheck = await requirePerm(req, 'provider_payout')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id is required as query param' }, { status: 400 })
  }

  const body = await req.json()
  const { name, isActive } = body

  const updateData: { name?: string; isActive?: boolean } = {}
  if (name !== undefined) updateData.name = name
  if (isActive !== undefined) updateData.isActive = isActive

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: 'name or isActive required' }, { status: 400 })
  }

  const lab = await prisma.lab.update({
    where: { id },
    data: updateData,
  })

  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'LAB_UPDATE',
      entity: 'Lab',
      entityId: lab.id,
      afterJson: JSON.stringify(updateData),
      notes: `Lab 更新: ${name ? '改名' : '停用/啟用'} → ${lab.name} (isActive=${lab.isActive})`,
    },
  } as any)

  return NextResponse.json({ lab })
}

// ============================================================
// DELETE /api/labs — Delete a lab (only if no cost cases reference it)
// Roles: OWNER (provider_payout via perm override)
// ============================================================
export async function DELETE(req: NextRequest) {
  const permCheck = await requirePerm(req, 'provider_payout')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id is required as query param' }, { status: 400 })
  }

  const used = await prisma.costCase.count({ where: { labId: id } })
  if (used > 0) {
    return jsonNoStore(
      { error: `已有 ${used} 筆成本記錄用過呢個工場，唔可以刪。可以改用「停用」。` },
      { status: 409 },
    )
  }

  await prisma.lab.delete({ where: { id } })

  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'LAB_DELETE',
      entity: 'Lab',
      entityId: id,
      notes: `刪除 Lab: ${id}`,
    },
  } as any)

  return NextResponse.json({ success: true })
}
