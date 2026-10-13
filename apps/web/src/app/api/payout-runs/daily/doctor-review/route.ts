/**
 * ★ cwm-dailyreview2-20261014：每日大數「核對同事」覆核（醫生 × 診所 × 日）
 * GET  ?clinicId=&providerId=&from=&to=
 *   → { reviews: { date, reviewerName, reviewedAt, snapshot }[], staff: { employeeId, name, onShift }[] | null }
 *   （staff 只有店舖帳號先有：要揀同事名先剔得）
 * POST { clinicId, providerId, from, to, dates: string[], checked: boolean, staffEmployeeId? }
 *   checked=true → 伺服器重新計數（唔信前端）、冇收款跳過、已覆核冇變唔重複寫
 *   checked=false → 取消（留紀錄）
 * 權限：同每日大數逐格剔一樣（OWNER＋KIOSK＋provider_payout）；KIOSK 只准自己店。
 */
export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { prisma } from '@/lib/prisma'
import { kioskClinicAllowed } from '@/lib/payout/daily-check'
import { validateCellRange } from '@/lib/payout/daily-cell-check'
import { DailyReportError } from '@/lib/payout/daily-report'
import { DoctorReviewError, loadDoctorReviews, reviewNeedsStaff, reviewStaffOptions, setDoctorReviews } from '@/lib/payout/daily-doctor-review'

function fail(e: unknown) {
  if (e instanceof DoctorReviewError || e instanceof DailyReportError) return jsonNoStore({ error: e.message }, { status: e.status })
  throw e
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const sp = new URL(req.url).searchParams
  const clinicId = sp.get('clinicId') ?? ''
  const providerId = sp.get('providerId') ?? ''
  if (!clinicId || !providerId) return jsonNoStore({ error: 'clinicId、providerId 必填' }, { status: 400 })
  const range = validateCellRange(sp.get('from') ?? '', sp.get('to') ?? sp.get('from') ?? '')
  if (!range.ok) return jsonNoStore({ error: range.error }, { status: 400 })
  if (!kioskClinicAllowed(auth.session!, clinicId)) return jsonNoStore({ error: '店舖帳號只可以核對自己間店' }, { status: 403 })
  try {
    const [reviews, staff] = await Promise.all([
      loadDoctorReviews(prisma, clinicId, providerId, range.from, range.to),
      reviewNeedsStaff(auth.session!) ? reviewStaffOptions(clinicId, range.to) : Promise.resolve(null),
    ])
    return jsonNoStore({ reviews, staff })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const b = await req.json().catch(() => ({} as any))
  const { clinicId, providerId, from, to, dates, checked, staffEmployeeId } = b ?? {}
  if (typeof clinicId !== 'string' || !clinicId || typeof providerId !== 'string' || !providerId || typeof checked !== 'boolean'
    || !Array.isArray(dates) || dates.length === 0 || dates.some((d: unknown) => typeof d !== 'string')) {
    return jsonNoStore({ error: 'clinicId、providerId、dates、checked 都係必填' }, { status: 400 })
  }
  const range = validateCellRange(typeof from === 'string' ? from : '', typeof to === 'string' ? to : '')
  if (!range.ok) return jsonNoStore({ error: range.error }, { status: 400 })
  if (!kioskClinicAllowed(auth.session!, clinicId)) return jsonNoStore({ error: '店舖帳號只可以核對自己間店' }, { status: 403 })
  try {
    const result = await setDoctorReviews({
      clinicId, providerId, from: range.from, to: range.to, dates, checked,
      actorId: auth.session!.userId, needsStaff: reviewNeedsStaff(auth.session!),
      staffEmployeeId: typeof staffEmployeeId === 'string' && staffEmployeeId ? staffEmployeeId : null,
    })
    return jsonNoStore({ ok: true, ...result })
  } catch (e) { return fail(e) }
}
