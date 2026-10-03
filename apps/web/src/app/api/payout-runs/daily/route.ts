/**
 * GET /api/payout-runs/daily?from=&to=&clinicId=&providerId=[&format=xlsx] — 每日大數（cwm-dailyrev-20261003）
 *
 * 揀診所（唔揀醫生）→ 行 = 醫生；揀醫生 → 行 = 逐日。數字 + Excel 同一份 data（lib/payout/daily-report.ts）。
 * 權限：同月結單（OWNER ＋ provider_payout 權限覆蓋）。
 * ★★★ 純讀，唔寫任何金額。
 */
export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import ExcelJS from 'exceljs'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { getOwnHomeClinicId } from '@/lib/scope-helpers'
import { loadDailyReport, DailyReportError } from '@/lib/payout/daily-report'
import { buildDailySheet } from '@/lib/payout/xlsx-report'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const sp = new URL(req.url).searchParams
  // ─── scope guard（同 clinic-report fail-closed）──────────────────
  let scopeClinics: string[] | null = null
  if (scope === 'my-clinics') scopeClinics = session.clinics ?? []
  else if (scope === 'self') {
    const home = await getOwnHomeClinicId(session.userId)
    scopeClinics = home ? [home] : []
  }

  let report
  try {
    report = await loadDailyReport({
      from: sp.get('from') ?? '',
      to: sp.get('to'),
      clinicId: sp.get('clinicId') || null,
      providerId: sp.get('providerId') || null,
      scopeClinics,
    })
  } catch (e) {
    if (e instanceof DailyReportError) return jsonNoStore({ error: e.message }, { status: e.status })
    throw e
  }

  if (sp.get('format') !== 'xlsx') return jsonNoStore(report)

  const wb = new ExcelJS.Workbook()
  buildDailySheet(wb, report)
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'PAYOUT_DAILY_EXPORT',
      entity: 'PayoutRun',
      entityId: 'daily',
      notes: `匯出每日大數：${report.title}`,
    },
  })
  const buf = await wb.xlsx.writeBuffer()
  const name = `每日大數_${report.from}${report.to !== report.from ? `_${report.to}` : ''}.xlsx`
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="daily_${report.from}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  })
}
