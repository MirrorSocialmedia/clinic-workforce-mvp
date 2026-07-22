export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/me — get current user info
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: {
      clinics: { include: { clinic: true } },
      employee: true,
    },
  })

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { password, permissionsJson, ...safeUser } = user
  const clinicIds = user.clinics.map((uc: any) => uc.clinicId)

  // Parse permissionsJson into grant/deny arrays
  let grant: string[] = []
  let deny: string[] = []
  try {
    if (permissionsJson) {
      const parsed = typeof permissionsJson === 'string'
        ? JSON.parse(permissionsJson)
        : permissionsJson
      grant = (parsed as any).grant || []
      deny = (parsed as any).deny || []
    }
  } catch {
    // ignore parse errors
  }

  // Check lunch break enabled status from active pay rule
  let lunchEnabled = false
  try {
    const activeRule = await prisma.payRule.findFirst({
      where: {
        employeeId: user.employee?.id,
        isActive: true,
      },
      orderBy: { effectiveFrom: 'desc' },
    })
    if (activeRule?.configJson) {
      const cfg = typeof activeRule.configJson === 'string'
        ? JSON.parse(activeRule.configJson)
        : activeRule.configJson
      lunchEnabled = !!(cfg?.modifiers?.lunch_break?.enabled)
    }
  } catch {
    // ignore
  }

  return NextResponse.json({
    user: {
      ...safeUser,
      clinicIds,
      grant,
      deny,
    },
    faceMode: process.env.FACE_MODE || 'shadow',
    lunchEnabled,
  })
}
