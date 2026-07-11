export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', '/api/my/timebank')
  if (isAuthError(auth)) return auth.error

  const tb = await calculateTimeBank(auth.session.userId, new Date(), {}, prisma)
  return NextResponse.json(tb)
}
