export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { syncPayments } from '@/lib/apricot/sync'

/** POST /api/apricot/sync — 手動觸發同步（OWNER only） */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, req.method, req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const { clinicId, from, to } = body

  if (!clinicId || !from || !to) {
    return NextResponse.json({ error: 'clinicId, from, to required' }, { status: 400 })
  }

  try {
    const result = await syncPayments(clinicId, from, to)
    if (!result) {
      return NextResponse.json({ error: '同步被鎖定（已有 call 進行中）' }, { status: 409 })
    }
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('[apricot/sync] 失敗', e)
    return NextResponse.json({ error: e.message || 'sync failed' }, { status: 500 })
  }
}
