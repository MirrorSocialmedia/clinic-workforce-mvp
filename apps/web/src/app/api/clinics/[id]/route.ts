// ownership-ok: IDCR: [id] 直接係 clinic ID，RBAC matrix 控制
export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'
import { jsonNoStore } from '@/lib/api-response'

// GET /api/clinics/:id — get single clinic
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const id = params.id

  // Data isolation for managers
  if (scope === 'my-clinics' && !(session.clinics ?? []).includes(id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id },
    include: {
      _count: { select: { users: true, employees: true, shifts: true } },
    },
  })

  if (!clinic) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return jsonNoStore({ clinic })
}

// PUT /api/clinics/:id — update clinic (OWNER only)
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const id = params.id
    const { name, address, config, shortName, companyId, latitude, longitude, geoRadius, color, apricotClinicId,
      capacityPerProvider, leadTimeMin, flowWindowDays, holdTimeoutHours } = await req.json()

    const HEX = /^#[0-9a-fA-F]{6}$/
    if (color !== undefined && color !== null && !HEX.test(String(color))) {
      return NextResponse.json({ error: '顏色格式必須為 #RRGGBB' }, { status: 400 })
    }

    // ★ providerslot-20260830 T2：可約時段四欄（正整數 + 範圍；undefined = 唔改）
    const INT_FIELDS: [string, unknown, number, number, string][] = [
      ['capacityPerProvider', capacityPerProvider, 1, 20, 'capacityPerProvider（按醫生同時上限）'],
      ['leadTimeMin', leadTimeMin, 0, 1440, 'leadTimeMin（最早可約 lead time，分鐘）'],
      ['flowWindowDays', flowWindowDays, 1, 365, 'flowWindowDays（Flow 出位窗口，日）'],
      ['holdTimeoutHours', holdTimeoutHours, 1, 168, 'holdTimeoutHours（HELD 逾時，小時）'],
    ]
    const intData: Record<string, number> = {}
    for (const [field, raw, min, max, label] of INT_FIELDS) {
      if (raw === undefined) continue
      const n = Number(raw)
      if (!Number.isInteger(n) || n < min || n > max) {
        return NextResponse.json({ error: `${label} 必須係 ${min}–${max} 整數` }, { status: 400 })
      }
      intData[field] = n
    }

    try {
      const clinic = await prisma.clinic.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(shortName !== undefined && { shortName }),
          ...(color !== undefined && { color: color || null }),
          ...(address !== undefined && { address }),
          ...(config && { config: JSON.stringify(config) }),
          ...(companyId !== undefined && { companyId: companyId || null }),
          ...(latitude !== undefined && { latitude: latitude != null ? Number(latitude) : null }),
          ...(longitude !== undefined && { longitude: longitude != null ? Number(longitude) : null }),
          ...(geoRadius !== undefined && { geoRadius: geoRadius != null ? Number(geoRadius) : null }),
          ...(apricotClinicId !== undefined && { apricotClinicId: apricotClinicId?.trim() || null }),
          ...intData,
        },
      })

      return NextResponse.json({ success: true, clinic })
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
      throw error
    }
  })
}

// DELETE /api/clinics/:id — delete clinic (OWNER only)
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'DELETE', req.url)
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
