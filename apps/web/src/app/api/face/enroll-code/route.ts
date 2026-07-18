export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// POST /api/face/enroll-code — Generate a 6-digit face enrollment code
// Roles: OWNER, MANAGER
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json().catch(() => ({}))
  const { employeeId } = body
  if (!employeeId) return NextResponse.json({ error: 'employeeId required' }, { status: 400 })

  const code = String(Math.floor(100000 + Math.random() * 900000))
  await prisma.faceEnrollCode.create({
    data: {
      employeeId,
      code,
      createdBy: session.userId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  })

  // Audit
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'FACE_ENROLL_CODE_ISSUED',
      entity: 'FaceEnrollCode',
      entityId: code,
      afterJson: JSON.stringify({ employeeId, code }),
      ipAddress: req.headers.get('x-forwarded-for') || null,
      userAgent: req.headers.get('user-agent') || null,
    },
  })

  return NextResponse.json({ code, expiresInMinutes: 10 })
}
