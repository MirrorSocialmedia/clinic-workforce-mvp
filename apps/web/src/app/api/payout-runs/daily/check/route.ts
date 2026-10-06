/**
 * ★ cwm-dailycheck-20261006：每日大數 —— 護士核對（每店每日一次）
 * GET  ?clinicId=&from=&to=  → 逐日核對狀態；單日再加護士名單（當日有更排前）
 * POST { clinicId, date, nurseEmployeeId, expectedAmount } → 確認核對
 * 權限：同每日大數（OWNER ＋ provider_payout）。店舖帳號（KIOSK）只可以核對自己綁定嘅店。
 */
export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { loadCheckStates, nurseOptions, createCheck, kioskClinicAllowed, DailyCheckError } from '@/lib/payout/daily-check'
import { DailyReportError } from '@/lib/payout/daily-report'

function fail(e: unknown) {
  if (e instanceof DailyCheckError || e instanceof DailyReportError) return jsonNoStore({ error: e.message }, { status: e.status })
  throw e
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const sp = new URL(req.url).searchParams
  const clinicId = sp.get('clinicId') ?? ''
  const from = sp.get('from') ?? ''
  const to = sp.get('to') || from
  if (!clinicId) return jsonNoStore({ error: '請揀診所' }, { status: 400 })
  try {
    const days = await loadCheckStates(clinicId, from, to)
    const nurses = from === to ? await nurseOptions(clinicId, from) : null
    return jsonNoStore({ days, nurses, canCheck: kioskClinicAllowed(auth.session!, clinicId) })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const body = await req.json().catch(() => ({} as any))
  const { clinicId, date, nurseEmployeeId, expectedAmount } = body ?? {}
  if (typeof clinicId !== 'string' || typeof date !== 'string' || typeof nurseEmployeeId !== 'string' || typeof expectedAmount !== 'number') {
    return jsonNoStore({ error: 'clinicId、date、nurseEmployeeId、expectedAmount 都係必填' }, { status: 400 })
  }
  if (!kioskClinicAllowed(auth.session!, clinicId)) return jsonNoStore({ error: '店舖帳號只可以核對自己間店' }, { status: 403 })
  try {
    const c = await createCheck({ clinicId, date, nurseEmployeeId, expectedAmount, actorId: auth.session!.userId })
    return jsonNoStore({ ok: true, id: c.id })
  } catch (e) { return fail(e) }
}
