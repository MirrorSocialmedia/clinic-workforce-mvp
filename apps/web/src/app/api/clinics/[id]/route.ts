import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { prisma, withAudit } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// GET /api/clinics/:id — get single clinic
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const id = params.id

  // Data isolation
  if (!CONFIG.UNRESTRICTED_ROLES.includes(session.role as any) && !session.clinics.includes(id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id },
    include: {
      _count: {
        select: { users: true, employees: true, shifts: true },
      },
    },
  })

  if (!clinic) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({ clinic })
}

// PUT /api/clinics/:id — update clinic (OWNER only)
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (session.role !== CONFIG.ROLES.OWNER) {
    return NextResponse.json({ error: 'Forbidden: OWNER only' }, { status: 403 })
  }

  setAuditContext(session.userId, req.headers.get('x-forwarded-for') || '', req.headers.get('user-agent') || '')

  const id = params.id
  const { name, address, config } = await req.json()

  const clinic = await withAudit(
    prisma.clinic.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(address !== undefined && { address }),
        ...(config && { config: JSON.stringify(config) }),
      },
    }),
    'Clinic'
  )

  return NextResponse.json({ success: true, clinic })
}

// DELETE /api/clinics/:id — delete clinic (OWNER only)
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (session.role !== CONFIG.ROLES.OWNER) {
    return NextResponse.json({ error: 'Forbidden: OWNER only' }, { status: 403 })
  }

  setAuditContext(session.userId, req.headers.get('x-forwarded-for') || '', req.headers.get('user-agent') || '')

  const id = params.id

  await withAudit(
    prisma.clinic.delete({ where: { id } }),
    'Clinic',
    () => id
  )

  return NextResponse.json({ success: true })
}
