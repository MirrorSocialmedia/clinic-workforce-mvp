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

  if (!from || !to) {
    return NextResponse.json({ error: 'from, to required' }, { status: 400 })
  }

  // ★ H4: 留空 = 全部有綁 apricotClinicId 的診所
  let targets: string[]
  if (clinicId) {
    targets = [clinicId]
  } else {
    const cs = await prisma.clinic.findMany({
      where: { apricotClinicId: { not: null } },
      select: { apricotClinicId: true },
      orderBy: { id: 'asc' },
    })
    targets = cs.map(c => c.apricotClinicId!).filter(Boolean)
    if (targets.length === 0) {
      return NextResponse.json({ error: '冇任何診所綁咗 Apricot ID' }, { status: 400 })
    }
  }

  const results: any[] = []
  try {
    // ★ 順序執行，唔准 Promise.all — 每次 call 可能 rotate token
    for (const t of targets) {
      const r = await syncPayments(t, from, to)
      if (r === null) {
        return NextResponse.json(
          { error: '同步被鎖定（已有 call 進行中）', partial: results },
          { status: 409 },
        )
      }
      results.push({ clinicExtId: t, ...r })
    }
    return NextResponse.json({ success: true, clinics: results.length, results })
  } catch (e: any) {
    console.error('[apricot/sync] 失敗', e)
    return NextResponse.json(
      { error: e.message || 'sync failed', done: results.length, partial: results },
      { status: 500 },
    )
  }
}
