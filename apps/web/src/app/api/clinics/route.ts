export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/clinics — list clinics
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const clinics = await prisma.clinic.findMany({ 
    orderBy: { createdAt: 'asc' },
    include: { company: { select: { id: true, name: true } } },
  })

  if (scope !== 'all') {
    const sessionClinics = session.clinics ?? []
    const filtered = clinics.filter((c: any) => sessionClinics.includes(c.id))
    return NextResponse.json({ clinics: filtered, total: filtered.length })
  }

  return NextResponse.json({ clinics, total: clinics.length })
}

// POST /api/clinics — create clinic (OWNER only)
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const { name, address, config, shortName, companyId, latitude, longitude, geoRadius } = await req.json()

      if (!name) {
        return NextResponse.json({ error: 'Name is required' }, { status: 400 })
      }
      if (!companyId) {
        return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
      }

      const clinic = await prisma.clinic.create({
        data: {
          name,
          shortName: shortName || null,
          address: address || null,
          latitude: latitude != null ? Number(latitude) : null,
          longitude: longitude != null ? Number(longitude) : null,
          geoRadius: geoRadius != null ? Number(geoRadius) : null,
          config: config ? JSON.stringify(config) : null,
          companyId,
        },
      })

      return NextResponse.json({ success: true, clinic }, { status: 201 })
    } catch (error) {
      console.error('Create clinic error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
