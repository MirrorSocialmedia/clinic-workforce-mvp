export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'

// GET /api/clinics/:id — get single clinic
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const id = params.id

  // Data isolation for managers
  if (scope === 'my-clinics' && !session.clinics.includes(id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id },
    include: {
      _count: { select: { users: true, employees: true, shifts: true } },
    },
  })

  if (!clinic) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ clinic })
}

// PUT /api/clinics/:id — update clinic (OWNER only)
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const id = params.id
    const { name, address, config, shortName, companyId } = await req.json()

    const clinic = await prisma.clinic.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(shortName !== undefined && { shortName }),
        ...(address !== undefined && { address }),
        ...(config && { config: JSON.stringify(config) }),
        ...(companyId !== undefined && { companyId: companyId || null }),
      },
    })

    return NextResponse.json({ success: true, clinic })
  })
}

// DELETE /api/clinics/:id — delete clinic (OWNER only)
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    await prisma.clinic.delete({ where: { id: params.id } })
    return NextResponse.json({ success: true })
  })
}
