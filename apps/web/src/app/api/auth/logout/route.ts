import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'

export async function POST(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  // For logout, accept any valid token but don't require RBAC
  if (!token) {
    const response = NextResponse.json({ error: 'No session' }, { status: 401 })
    response.cookies.set('session', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 0, path: '/' })
    return response
  }

  // Use verifyToken directly for logout (no RBAC needed)
  const { verifyToken } = await import('@/lib/auth')
  const session = verifyToken(token)

  if (session?.userId) {
    const auditCtx = {
      actorId: session.userId,
      ip: req.headers.get('x-forwarded-for') || undefined,
      ua: req.headers.get('user-agent') || undefined,
    }

    await runWithAudit(auditCtx, async () => {
      await prisma.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'LOGOUT',
          entity: 'Session',
          entityId: session.userId,
          notes: `Logout from ${req.headers.get('x-forwarded-for') || 'unknown'}`,
          ipAddress: auditCtx.ip || null,
          userAgent: auditCtx.ua || null,
        },
      })
    })
  }

  const response = NextResponse.json({ success: true })
  response.cookies.set('session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  })

  return response
}
