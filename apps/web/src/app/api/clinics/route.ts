export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/clinics — list clinics
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope, perms } = auth

  const clinics = await prisma.clinic.findMany({ 
    orderBy: { createdAt: 'asc' },
    include: { company: { select: { id: true, name: true } } },
  })

  // ★ 有編更權限 = 要排全部店，所以要見到全部診所（診所名單本身唔敏感）
  const canSeeAllClinics = scope === 'all' || (perms ?? []).includes('scheduling')

  if (!canSeeAllClinics) {
    const sessionClinics = session.clinics ?? []
    const filtered = clinics.filter((c: any) => sessionClinics.includes(c.id))
    return NextResponse.json(
      { clinics: filtered, total: filtered.length },
      { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
    )
  }

  return NextResponse.json(
    { clinics, total: clinics.length },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  )
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
    const { name, address, config, shortName, companyId, latitude, longitude, geoRadius, color, apricotClinicId } = await req.json()

    try {
      if (!name) {
        return NextResponse.json({ error: 'Name is required' }, { status: 400 })
      }
      if (!companyId) {
        return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
      }
      const HEX = /^#[0-9a-fA-F]{6}$/
      if (color !== undefined && color !== null && !HEX.test(String(color))) {
        return NextResponse.json({ error: '顏色格式必須為 #RRGGBB' }, { status: 400 })
      }

      const clinic = await prisma.clinic.create({
        data: {
          name,
          shortName: shortName || null,
          color: color || null,
          address: address || null,
          latitude: latitude != null ? Number(latitude) : null,
          longitude: longitude != null ? Number(longitude) : null,
          geoRadius: geoRadius != null ? Number(geoRadius) : null,
          config: config ? JSON.stringify(config) : null,
          companyId,
          ...(apricotClinicId !== undefined && { apricotClinicId: apricotClinicId?.trim() || null }),
        },
      })

      return NextResponse.json({ success: true, clinic }, { status: 201 })
    } catch (error) {
      if ((error as any)?.code === 'P2002') {
        const target = (error as any)?.meta?.target
        const isApricot = Array.isArray(target)
          ? target.includes('apricotClinicId')
          : String(target ?? '').includes('apricotClinicId')
        return NextResponse.json(
          { error: isApricot
            ? `Apricot 診所 ID「${apricotClinicId}」已經綁咗另一間診所`
            : '資料重複' },
          { status: 409 }
        )
      }
      console.error('Create clinic error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
