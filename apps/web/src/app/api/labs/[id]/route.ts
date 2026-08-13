import { NextRequest, NextResponse } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// PUT /api/labs/:id — Update a lab
// Roles: OWNER (provider_payout via perm override)
// Body: { name?, isActive?, sortOrder? }
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const permCheck = await requirePerm(req, 'provider_payout')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const { id } = await params
  const existing = await prisma.lab.findUnique({ where: { id } })

  if (!existing) {
    return jsonNoStore({ error: '搵唔到記錄' }, { status: 404 })
  }

  const body = await req.json()
  const { name, isActive, sortOrder } = body

  const data: any = {}
  if (name !== undefined) data.name = name
  if (isActive !== undefined) data.isActive = isActive
  if (sortOrder !== undefined) data.sortOrder = sortOrder

  const updated = await prisma.lab.update({ where: { id }, data })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_UPDATE',
      entity: 'Lab',
      entityId: id,
      beforeJson: JSON.stringify({ name: existing.name, isActive: existing.isActive }),
      afterJson: JSON.stringify({ name: updated.name, isActive: updated.isActive }),
      notes: `更新 Lab: ${updated.name}`,
    },
  } as any)

  return jsonNoStore({ lab: updated })
}
