import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import prisma from '@/lib/prisma'

// GET /api/me — get current user info
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
  })
}
