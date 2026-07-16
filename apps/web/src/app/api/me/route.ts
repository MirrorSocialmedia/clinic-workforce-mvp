export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/me — get current user info
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
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

  const { password, ...safeUser } = user
  const clinicIds = user.clinics.map((uc: any) => uc.clinicId)

  return NextResponse.json({
    user: {
      ...safeUser,
      clinicIds,
    },
    faceMode: process.env.FACE_MODE || 'shadow',
  })
}
