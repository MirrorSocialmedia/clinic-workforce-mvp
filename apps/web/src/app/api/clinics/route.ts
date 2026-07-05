import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/clinics — list clinics
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const clinics = await prisma.clinic.findMany({ orderBy: { createdAt: 'asc' } })

  if (scope !== 'all') {
    const filtered = clinics.filter((c: any) => session.clinics.includes(c.id))
    return NextResponse.json({ clinics: filtered, total: filtered.length })
  }

  return NextResponse.json({ clinics, total: clinics.length })
}

// POST /api/clinics — create clinic (OWNER only)
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const { name, address, config } = await req.json()

      if (!name) {
        return NextResponse.json({ error: 'Name is required' }, { status: 400 })
      }

      const clinic = await prisma.clinic.create({
        data: {
          name,
          address: address || null,
          config: config ? JSON.stringify(config) : null,
        },
      })

      return NextResponse.json({ success: true, clinic }, { status: 201 })
    } catch (error) {
      console.error('Create clinic error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}
