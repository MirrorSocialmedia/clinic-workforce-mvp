export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/shifts/templates — list shift templates (scoped by companyId)
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  try {
    const { searchParams } = new URL(req.url)
    const companyId = searchParams.get('companyId')
    if (!companyId) {
      return NextResponse.json({ error: '缺少 companyId' }, { status: 400 })
    }

    const templates = await prisma.shiftTemplate.findMany({
      where: { isActive: true, companyId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })

    if (templates.length === 0) {
      const defaults = await seedDefaultTemplates(companyId)
      return NextResponse.json({ templates: defaults, seeded: true, total: defaults.length })
    }

    return NextResponse.json({ templates, seeded: false, total: templates.length })
  } catch (error) {
    console.error('Get templates error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============================================================
// POST /api/shifts/templates — create shift template (scoped by companyId)
// Roles: OWNER
// ============================================================
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
      const body = await req.json()
      const { name, shortName, startHour, startMinute, endHour, endMinute, isNightShift, companyId } = body

      if (!name || startHour === undefined || endHour === undefined) {
        return NextResponse.json(
          { error: 'name, startHour, and endHour are required' },
          { status: 400 }
        )
      }

      if (!companyId) {
        return NextResponse.json(
          { error: 'companyId is required' },
          { status: 400 }
        )
      }

      const template = await prisma.shiftTemplate.create({
        data: {
          name,
          shortName: shortName || null,
          startHour,
          startMinute: startMinute ?? 0,
          endHour,
          endMinute: endMinute ?? 0,
          isNightShift: isNightShift ?? false,
          createdBy: session.userId,
          companyId,
        },
      })

      // Audit handled by Prisma extension

      return NextResponse.json({ success: true, template }, { status: 201 })
    } catch (error) {
      console.error('Create template error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  })
}

async function seedDefaultTemplates(companyId: string): Promise<any[]> {
  const defaults = [
    {
      name: '全日',
      startHour: 9, startMinute: 0,
      endHour: 18, endMinute: 0,
      isNightShift: false,
      isDefault: true,
      companyId,
    },
  ]

  const created = []
  for (const d of defaults) {
    const template = await prisma.shiftTemplate.create({ data: d })
    created.push(template)
  }
  return created
}

// ============================================================
// DELETE /api/shifts/templates/[id] — delete shift template
// Roles: OWNER
// ============================================================
// Note: This is a catch-all route for DELETE requests to /api/shifts/templates/[id]
// The actual handler is in apps/web/src/app/api/shifts/templates/[id]/route.ts
// If that doesn't exist, we handle it here via a workaround
