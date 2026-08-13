export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { syncPayments } from '@/lib/apricot/sync'

/** POST /api/apricot/sync/cron — cron 專用（x-cron-key 認證，唔入 RBAC） */
export async function POST(req: NextRequest) {
  // x-cron-key 認證
  const cronKey = req.headers.get('x-cron-key')
  const expectedKey = process.env.APRICOT_CRON_KEY

  if (!cronKey || !expectedKey || cronKey !== expectedKey) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({} as any))
  const { clinicId, from, to } = body

  if (!clinicId || !from || !to) {
    return NextResponse.json({ error: 'clinicId, from, to required' }, { status: 400 })
  }

  try {
    const result = await syncPayments(clinicId, from, to)
    if (!result) {
      return NextResponse.json({ message: 'skipped (lock held)' }, { status: 200 })
    }
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('[apricot/sync/cron] 失敗', e)
    return NextResponse.json({ error: e.message || 'sync failed' }, { status: 500 })
  }
}
