/**
 * ★ cwm-dailyv2-20261007 ④：每日大數 —— 逐格「已對」tick（醫生 × 付款方式）
 * GET  ?clinicId=&from=&to= 或 ?clinicId=&date=（單日 = from=to=date）
 *   → { cells: { date, rowKey, colKey, amount, checkedName, checkedAt }[] }（★ cwm-dailyv3-20261010 §5a：日期範圍，上限 62 日）
 * POST { clinicId, date, rowKey, colKey, checked: boolean, nurseEmployeeId? }
 *   checked=true  → 伺服器重新計該格金額（唔信前端），0/搵唔到 → 400「呢格冇數」，upsert
 *   checked=false → deleteMany（idempotent）
 * 權限：OWNER＋KIOSK（KIOSK 經 kioskClinicAllowed 只准自己店）＋ provider_payout 權限覆蓋。
 * 審計：DAILY_CELL_CHECK / DAILY_CELL_UNCHECK（lib 內寫，notes 冇病人資料）。
 */
export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { loadCellChecks, setCellCheck, validateCellRange, kioskClinicAllowed, DailyCellCheckError } from '@/lib/payout/daily-cell-check'
import { DailyReportError } from '@/lib/payout/daily-report'

function fail(e: unknown) {
  if (e instanceof DailyCellCheckError || e instanceof DailyReportError) {
    return jsonNoStore({ error: e.message }, { status: e.status })
  }
  throw e
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const sp = new URL(req.url).searchParams
  const clinicId = sp.get('clinicId') ?? ''
  // ★ cwm-dailyv3-20261010 §5a：日期範圍（from/to）；date= 照舊支援（= from = to = date）
  const date = sp.get('date') ?? ''
  const fromQ = sp.get('from') ?? ''
  const toQ = sp.get('to') ?? ''
  const from = fromQ || (date ? date : '')
  const to = toQ || from
  if (!clinicId) return jsonNoStore({ error: 'clinicId 必填' }, { status: 400 })
  if (!from) return jsonNoStore({ error: 'date 或 from 必填' }, { status: 400 })
  const range = validateCellRange(from, to)
  if (!range.ok) return jsonNoStore({ error: range.error }, { status: 400 })
  if (!kioskClinicAllowed(auth.session!, clinicId)) return jsonNoStore({ error: '店舖帳號只可以核對自己間店' }, { status: 403 })
  try {
    const cells = await loadCellChecks(clinicId, range.from, range.to)
    return jsonNoStore({ cells })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const body = await req.json().catch(() => ({} as any))
  const { clinicId, date, rowKey, colKey, checked, nurseEmployeeId } = body ?? {}
  if (typeof clinicId !== 'string' || typeof date !== 'string' || typeof rowKey !== 'string' || typeof colKey !== 'string' || typeof checked !== 'boolean') {
    return jsonNoStore({ error: 'clinicId、date、rowKey、colKey、checked 都係必填' }, { status: 400 })
  }
  if (!kioskClinicAllowed(auth.session!, clinicId)) return jsonNoStore({ error: '店舖帳號只可以核對自己間店' }, { status: 403 })
  try {
    await setCellCheck({
      clinicId, date, rowKey, colKey, checked,
      nurseEmployeeId: typeof nurseEmployeeId === 'string' && nurseEmployeeId ? nurseEmployeeId : null,
      actorId: auth.session!.userId,
    })
    return jsonNoStore({ ok: true })
  } catch (e) { return fail(e) }
}
