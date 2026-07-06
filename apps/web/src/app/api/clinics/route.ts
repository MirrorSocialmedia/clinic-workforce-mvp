export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import { prisma, withAudit } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

// GET /api/clinics — list clinics
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const clinics = await prisma.clinic.findMany({
    orderBy: { createdAt: 'asc' },
  })

  // Data isolation: non-OWNER roles only see their clinics
  if (!CONFIG.UNRESTRICTED_ROLES.includes(session.role as any)) {
    const filtered = clinics.filter((c: any) => session.clinics.includes(c.id))
    return NextResponse.json({
      clinics: filtered,
      total: filtered.length,
    })
  }

  return NextResponse.json({ clinics, total: clinics.length })
}

// POST /api/clinics — create clinic (OWNER only)
export async function POST(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (session.role !== CONFIG.ROLES.OWNER) {
    return NextResponse.json({ error: 'Forbidden: OWNER only' }, { status: 403 })
  }

  setAuditContext(session.userId, req.headers.get('x-forwarded-for') || '', req.headers.get('user-agent') || '')

  try {
    const { name, address, config } = await req.json()

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const clinic = await withAudit(
      prisma.clinic.create({
        data: {
          name,
          address: address || null,
          config: config ? JSON.stringify(config) : null,
        },
      }),
      'Clinic'
    )

    return NextResponse.json({ success: true, clinic }, { status: 201 })
  } catch (error) {
    console.error('Create clinic error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
