export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma, createAuditLog } from '@/lib/prisma'
import { setAuditContext } from '@/lib/audit-context'

export async function POST(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (session?.userId) {
    setAuditContext(session.userId, req.headers.get('x-forwarded-for') || '', req.headers.get('user-agent') || '')

    // Write audit log for logout
    await createAuditLog({
      action: 'LOGOUT',
      entity: 'Session',
      entityId: session.userId,
      notes: `Logout from ${req.headers.get('x-forwarded-for') || 'unknown'}`,
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
