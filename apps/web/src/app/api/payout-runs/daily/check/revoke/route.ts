/**
 * ★ cwm-dailycheck-20261006：取消每日大數核對（要填原因，入審計紀錄）
 * POST { clinicId, date, reason }
 */
export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { revokeCheck, kioskClinicAllowed, DailyCheckError } from '@/lib/payout/daily-check'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const body = await req.json().catch(() => ({} as any))
  const { clinicId, date, reason } = body ?? {}
  if (typeof clinicId !== 'string' || typeof date !== 'string') return jsonNoStore({ error: 'clinicId、date 必填' }, { status: 400 })
  if (!kioskClinicAllowed(auth.session!, clinicId)) return jsonNoStore({ error: '店舖帳號只可以處理自己間店' }, { status: 403 })
  try {
    await revokeCheck({ clinicId, date, reason: typeof reason === 'string' ? reason : '', actorId: auth.session!.userId })
    return jsonNoStore({ ok: true })
  } catch (e) {
    if (e instanceof DailyCheckError) return jsonNoStore({ error: e.message }, { status: e.status })
    throw e
  }
}
