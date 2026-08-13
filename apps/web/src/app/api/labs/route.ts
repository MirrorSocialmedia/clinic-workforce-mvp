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
